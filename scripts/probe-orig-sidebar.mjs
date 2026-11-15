// scripts/probe-orig-sidebar.mjs —— 录前自检：右侧原文栏点得动吗？
//
// 【为什么需要这个探针】
// 2026-11-15 加完原文侧栏后，它是**只读**的：点某一段不会定位，也没有"回到当前块"的入口。
// 评委现场一定会问"这能点吗"——点了没反应比不能点更糟，所以补了交互。
// 但交互这类东西 API 层测不出来：它完全活在客户端 state 与渲染里，
// 必须在真浏览器里点一次、看 DOM 变没变，才算验过。
//
// 判据（四条，任一不过即 exit 1）：
//   1. 侧栏渲染出多段原文，且恰好有一段带 .is-now（评委正在读的那块）
//   2. 点另一段 → 那段变 .is-peek、原 .is-now 仍然是 .is-now（评委的位置不许被改）
//   3. 页头从"当前 BLOCK n"变成"查看 BLOCK m"，并出现回程按钮 .orig-back
//   4. 点回程按钮 → 回到跟随状态（.is-peek 消失、页头恢复"当前 BLOCK n"）
//
// 用法：
//   node scripts/probe-orig-sidebar.mjs
//   $env:BASE='http://127.0.0.1:3111'; node scripts/probe-orig-sidebar.mjs
//   node scripts/probe-orig-sidebar.mjs --shot .shots/orig-sidebar.png
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const DEMO_DOC = process.env.DEMO_DOC ?? '07b4f607-5393-4617-82b4-a5ea67e605dc';
const shotArg = process.argv.indexOf('--shot');
const OUT = shotArg > -1 ? process.argv[shotArg + 1] : '.shots/orig-sidebar.png';
const PORT = 9343;
const W = 1440;
const H = 1600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1) 建一场全新 quick 会话 ----------
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

// ---------- 2) 起无头浏览器 ----------
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('[FAIL] 找不到 Edge/Chrome');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-orig-'));
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

// ---------- 3) 等侧栏与当前块就位 ----------
// 判据：.orig-block 至少两段，且有且仅有一段 .is-now
let shape = null;
let ready = false;
for (let i = 0; i < 160; i += 1) {
  shape = await evaluate(`(() => {
    const all = document.querySelectorAll('.orig-block');
    const now = document.querySelectorAll('.orig-block.is-now');
    return {
      blocks: all.length,
      now: now.length,
      nowIdx: now.length === 1 ? now[0].dataset.idx : null,
      head: document.querySelector('.orig-head')?.innerText ?? '',
    };
  })()`);
  if (shape.blocks >= 2 && shape.now === 1) {
    ready = true;
    break;
  }
  await sleep(300);
}
if (!ready) {
  console.error('[FAIL] 侧栏没渲染出「多段原文 + 唯一当前块」：', JSON.stringify(shape));
  process.exit(1);
}
console.log(`[probe] 侧栏 ${shape.blocks} 段，当前 BLOCK ${shape.nowIdx}，页头「${shape.head.replace(/\n/g, ' ')}」`);

// ---------- 4) 判据 1 的强断言：页头必须写"当前 BLOCK" ----------
if (!/当前 BLOCK/.test(shape.head)) {
  console.error('[FAIL] 页头没写「当前 BLOCK」：', shape.head);
  process.exit(1);
}

// ---------- 5) 点另一段（不能是当前段） ----------
const target = await evaluate(`(() => {
  const now = document.querySelector('.orig-block.is-now');
  const nowIdx = now ? Number(now.dataset.idx) : null;
  const other = [...document.querySelectorAll('.orig-block')].find((b) => Number(b.dataset.idx) !== nowIdx);
  if (!other) return null;
  const idx = Number(other.dataset.idx);
  other.click();
  return idx;
})()`);
if (target === null) {
  console.error('[FAIL] 除了当前块之外没有可点的段');
  process.exit(1);
}
await sleep(500);

const afterPeek = await evaluate(`(() => {
  const peek = document.querySelector('.orig-block.is-peek');
  const now = document.querySelector('.orig-block.is-now');
  const back = document.querySelector('.orig-back');
  return {
    peekIdx: peek ? Number(peek.dataset.idx) : null,
    nowIdx: now ? Number(now.dataset.idx) : null,
    head: document.querySelector('.orig-head')?.innerText ?? '',
    hasBack: Boolean(back),
    ariaCurrent: peek ? peek.getAttribute('aria-current') : null,
  };
})()`);

if (afterPeek.peekIdx !== target) {
  console.error(`[FAIL] 点了 BLOCK ${target}，但它没变成 .is-peek：`, JSON.stringify(afterPeek));
  process.exit(1);
}
// 关键一条：评委在读的那块不许因为用户翻页而改变
if (afterPeek.nowIdx !== Number(shape.nowIdx)) {
  console.error(`[FAIL] 用户翻页把「评委正在读」的块改了：${shape.nowIdx} → ${afterPeek.nowIdx}`);
  process.exit(1);
}
if (afterPeek.head.includes('当前 BLOCK')) {
  console.error('[FAIL] 翻到别处了，页头却还写「当前 BLOCK」：', afterPeek.head);
  process.exit(1);
}
if (!/查看 BLOCK/.test(afterPeek.head)) {
  console.error('[FAIL] 页头没如实写「查看 BLOCK n」：', afterPeek.head);
  process.exit(1);
}
if (!afterPeek.hasBack) {
  console.error('[FAIL] 翻到别处后没出现回程按钮 .orig-back');
  process.exit(1);
}
console.log(`[probe] ✓ 点 BLOCK ${target} → is-peek，评委位置仍 BLOCK ${afterPeek.nowIdx}，页头「${afterPeek.head.replace(/\n/g, ' ')}」`);

// 留一张"翻到别处"的图
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const shot1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(OUT, Buffer.from(shot1.data, 'base64'));

// ---------- 6) 点回程按钮，必须回到跟随 ----------
await evaluate(`document.querySelector('.orig-back').click()`);
await sleep(500);

const afterBack = await evaluate(`(() => ({
  peek: document.querySelectorAll('.orig-block.is-peek').length,
  nowIdx: document.querySelector('.orig-block.is-now')?.dataset.idx ?? null,
  head: document.querySelector('.orig-head')?.innerText ?? '',
  hasBack: Boolean(document.querySelector('.orig-back')),
}))()`);

if (afterBack.peek !== 0) {
  console.error('[FAIL] 点了回程按钮，.is-peek 仍在：', JSON.stringify(afterBack));
  process.exit(1);
}
if (!/当前 BLOCK/.test(afterBack.head)) {
  console.error('[FAIL] 回来后页头没恢复「当前 BLOCK」：', afterBack.head);
  process.exit(1);
}
if (afterBack.hasBack) {
  console.error('[FAIL] 回来后回程按钮还在（它无处可回，出现就是误导）');
  process.exit(1);
}
console.log(`[probe] ✓ 点回程 → 恢复跟随，页头「${afterBack.head.replace(/\n/g, ' ')}」`);

ws.close();
cleanup();

console.log(`[OK] 原文侧栏可交互：点段定位、评委位置不被改、可一键回到当前块（图 ${OUT}）`);
