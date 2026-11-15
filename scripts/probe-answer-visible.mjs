// scripts/probe-answer-visible.mjs —— 录前自检：答完之后，屏幕上还看得见我刚才写的回答吗？
//
// 【为什么要单独有这个探针】
// 2026-11-15 录制前实测发现：点「提交并判分」之后，输入框被清空（正确），
// 但判分面板只有分数/缺口/出处，**回答原文一个字都不剩**；GET /api/sessions/:id 那时也不返回 turns，
// 刷新即丢。录制时这一镜头就是"评委问 → 分数出现，中间我的作答凭空消失"。
// 修法是：判分面板自带回答快照 + 会话页顶部渲染 history 时间线（P1）。
//
// 这个探针守的就是这条回归——它必须**真在浏览器里点一次提交**，
// 因为回答原文能不能看见，是客户端 state 与渲染的产物，API 层答对了不等于页面答对了。
//
// 判据（三条，任一不过即 exit 1）：
//   1. 提交后 `.verdict-answer-text` 或 `.hist-atext` 里能读到回答里的一句原话
//   2. 页面上出现分数（"本问得分"），说明判分真的回来了，不是卡在 submitting
//   3. 作答输入框在非"还能再答同一问"的情形下已被清空（不能留旧答案让人误以为要再交一次）
//
// 用法：
//   node scripts/probe-answer-visible.mjs
//   $env:BASE='http://127.0.0.1:3111'; node scripts/probe-answer-visible.mjs
//   node scripts/probe-answer-visible.mjs --shot docs/shots/answer-visible.png
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const DEMO_DOC = process.env.DEMO_DOC ?? '07b4f607-5393-4617-82b4-a5ea67e605dc';
const shotArg = process.argv.indexOf('--shot');
const OUT = shotArg > -1 ? process.argv[shotArg + 1] : 'docs/shots/answer-visible.png';
const PORT = 9341;
const W = 1280;
const H = 1600;

// 回答要带一句**独特到能被唯一搜到**的原话，断言才不会假阳性
const ANSWER =
  '目前确实没划出留出集——800 条全部参与了多轮调优，96.8% 是在同一批上算的，泛化确实存疑。' +
  '这正是这份材料风险偏高、我也认下的原因；revise 时我会切出独立留出集重报一次。';
const ANSWER_PROBE = '800 条全部参与了多轮调优';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1) 先建一场全新的 quick 会话（不污染手工演示过的那几场） ----------
const created = await (
  await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: DEMO_DOC, mode: 'quick' }),
  })
).json();
if (!created?.sessionId) {
  console.error('[FAIL] 建会话失败：', JSON.stringify(created ?? {}).slice(0, 300));
  process.exit(1);
}
const sessionUrl = `${BASE}/session/${created.sessionId}`;
console.log(`[probe] 新会话 ${created.sessionId}`);

// ---------- 2) 起一个无头浏览器，用 CDP 驱动 ----------
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('[FAIL] 找不到 Edge/Chrome，无法做真 UI 断言');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-answer-'));
const child = spawn(
  exe,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--headless=new',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
};
process.on('exit', cleanup);

async function wsEndpoint() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await wsEndpoint());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 失败')), { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 30_000);
  });
};
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate 抛错');
  return result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: sessionUrl });

// ---------- 3) 等提问流跑完（作答输入框出现） ----------
let ready = false;
for (let i = 0; i < 120; i += 1) {
  if (await evaluate(`Boolean(document.querySelector('textarea.answer-input'))`)) {
    ready = true;
    break;
  }
  await sleep(300);
}
if (!ready) {
  console.error(`[FAIL] 等不到作答输入框（${sessionUrl} 的流没跑完？）`);
  process.exit(1);
}
console.log('[probe] 输入框已出现');

// ---------- 4) 填答案并真点「提交并判分」 ----------
// React 受控组件：必须走原生 value setter + input 事件，直接改 .value 不会触发 onChange
await evaluate(`(() => {
  const ta = document.querySelector('textarea.answer-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(ANSWER)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
})()`);
await sleep(400);

const clicked = await evaluate(`(() => {
  const b = document.querySelector('button.answer-submit');
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
if (!clicked) {
  console.error('[FAIL] 提交按钮不可点（仍在 submitting 或答案为空）');
  process.exit(1);
}
console.log('[probe] 已点提交');

// ---------- 5) 等回答原文重新出现在屏幕上 ----------
// 两条落点都算通过：
//   ① 答的是主问 → decision=followup，判分面板留在原地 → .verdict-answer-text
//   ② 答的是追问 → decision=ask，页面前进到下一问，这一问并进 history → .hist-atext
// 验收口径是"回答有没有留在屏幕上"，不是"留在哪个容器里"。
let state = null;
let ok = false;
for (let i = 0; i < 120; i += 1) {
  state = await evaluate(`(() => {
    const t = document.body.innerText;
    return {
      answerOnScreen: t.includes(${JSON.stringify(ANSWER_PROBE)}),
      verdictAnswer: Boolean(document.querySelector('.verdict-answer-text')),
      historyItems: document.querySelectorAll('.hist-item').length,
      hasScore: /本问得分/.test(t),
    };
  })()`);
  if (state.answerOnScreen && state.hasScore) {
    ok = true;
    break;
  }
  await sleep(300);
}

if (!ok) {
  console.error('[FAIL] 提交后页面上读不到回答原文 / 没出现判分：', JSON.stringify(state));
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.error(`[FAIL] 现场截图 ${OUT}`);
  } catch {
    /* 截图失败不掩盖原始失败 */
  }
  process.exit(1);
}
console.log(`[probe] ✓ 回答原文仍在屏幕上（判分面板：${state.verdictAnswer}，历史条目：${state.historyItems}）`);

// ---------- 6) 留一张图给人看 ----------
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`[probe] 截图 ${OUT}`);

ws.close();
cleanup();

console.log('[OK] 答完之后屏幕上仍能看见自己写的回答');
