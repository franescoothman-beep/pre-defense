/**
 * 探针：一屏之内能不能直接开始答题（录制现场最要紧的一条）。
 *
 * 2026-11-15 录制前 CDP 实测（视口 1440×900）：
 *   `.history` top=259 h=614（只答过 2 轮）
 *   `.answer`  top=1190 h=233 → **在整屏之外**，要滚一整屏才够得着作答框
 * 修法：历史默认折叠 + 作答区 sticky 钉底。
 *
 * 四条判据（任一不过 exit 1）：
 *   1. 已答记录默认折叠：`.hist-item.is-open` 数量为 0（有历史时）
 *   2. 作答框在首屏内：`.answer` 的 rect.top + rect.height <= 视口高度
 *   3. 点一条折叠头能展开，再点能收起（`.hist-item.is-open` 0 → 1 → 0）
 *   4. 「全部展开」能把所有条目一起打开
 *
 * 用法：node scripts/probe-answer-first-screen.mjs [--shot path]
 * 默认 BASE=http://127.0.0.1:3111，需 MOCK 服务在跑。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const DOC = '07b4f607-5393-4617-82b4-a5ea67e605dc';
const ANSWER = '这一问我们确实考虑了。800 条评测集在多轮调优里反复用过，96.8% 正是调在这同一批上算的。';
const PORT = 9347;
const shotIdx = process.argv.indexOf('--shot');
const SHOT = shotIdx > -1 ? process.argv[shotIdx + 1] : '.shots/answer-first-screen.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createSession() {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: DOC, mode: 'quick' }),
  });
  if (!r.ok) throw new Error(`建会话失败 ${r.status} ${await r.text()}`);
  return (await r.json()).sessionId;
}

async function streamOne(sessionId) {
  const r = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  const text = await r.text();
  let turnId = null;
  for (const block of text.split('\n\n').filter(Boolean)) {
    const ev = block.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (ev !== 'done' || !dataLine) continue;
    try {
      turnId = JSON.parse(dataLine).turnId ?? null;
    } catch {
      /* ignore */
    }
  }
  return turnId;
}

async function answer(sessionId, turnId) {
  const r = await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnId, answer: ANSWER }),
  });
  if (!r.ok) throw new Error(`answer 失败 ${r.status}`);
  return r.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 失败');
    return r.result.value;
  }
  async waitFor(expr, timeoutMs = 20000, label = expr) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expr)) return;
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'probe-first-screen-'));
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const { existsSync } = await import('node:fs');
const edge = BROWSERS.find((p) => existsSync(p));
if (!edge) throw new Error('找不到 Edge/Chrome');

const child = spawn(edge, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  const sessionId = await createSession();
  console.log(`[probe] 新会话 ${sessionId}`);

  // 先答掉第 1 问与它的追问，制造"有历史"的现场
  const t1 = await streamOne(sessionId);
  const a1 = await answer(sessionId, t1);
  if (a1.decision === 'followup') await answer(sessionId, a1.followup.turnId);
  console.log('[probe] 已答完第 1 问与追问，历史应有 2 条');

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch {
      /* 还没起 */
    }
  }
  if (!wsUrl) throw new Error('连不上 CDP');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send('Page.navigate', { url: `${BASE}/session/${sessionId}` });
  await cdp.waitFor(`document.querySelectorAll('.hist-item').length >= 2`, 25000, '历史里出现 2 条');
  await sleep(600);

  // 判据 1：默认全折叠
  const openCount = await cdp.eval(`document.querySelectorAll('.hist-item.is-open').length`);
  const itemCount = await cdp.eval(`document.querySelectorAll('.hist-item').length`);
  if (openCount !== 0) throw new Error(`判据 1 失败：默认应全折叠，实际展开 ${openCount} 条`);
  console.log(`[probe] ✓ 判据 1 默认折叠：${itemCount} 条历史全部收起`);

  // 判据 2：作答框在首屏内
  const box = await cdp.eval(`(() => {
    const el = document.querySelector('.answer');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), vh: window.innerHeight };
  })()`);
  if (!box) throw new Error('判据 2 失败：页面上没有 .answer');
  const visible = box.top + box.height <= box.vh + 1;
  console.log(`[probe] ${visible ? '✓' : '✗'} 判据 2 作答框：top=${box.top} h=${box.height} 视口=${box.vh} → ${visible ? '在首屏内' : '仍在屏外'}`);
  if (!visible) throw new Error('判据 2 失败：作答框不在首屏内');

  // 截图（折叠态）
  const shotFold = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(shotFold.data, 'base64'));
  console.log(`[probe] 折叠态截图 ${SHOT}`);

  // 判据 3：点第一条能展开，再点能收起
  await cdp.eval(`document.querySelector('.hist-row').click()`);
  await sleep(250);
  const afterOpen = await cdp.eval(`document.querySelectorAll('.hist-item.is-open').length`);
  if (afterOpen !== 1) throw new Error(`判据 3 失败：点开一条后应有 1 条展开，实际 ${afterOpen}`);
  await cdp.eval(`document.querySelector('.hist-row').click()`);
  await sleep(250);
  const afterClose = await cdp.eval(`document.querySelectorAll('.hist-item.is-open').length`);
  if (afterClose !== 0) throw new Error(`判据 3 失败：再点一次应收起，实际还开着 ${afterClose}`);
  console.log('[probe] ✓ 判据 3 单条展开 / 收起');

  // 判据 4：「全部展开」
  await cdp.eval(`document.querySelector('.hist-toggle-all').click()`);
  await sleep(250);
  const allOpen = await cdp.eval(`document.querySelectorAll('.hist-item.is-open').length`);
  if (allOpen !== itemCount) throw new Error(`判据 4 失败：全部展开后应有 ${itemCount} 条，实际 ${allOpen}`);
  console.log(`[probe] ✓ 判据 4 全部展开：${allOpen} 条`);

  await cdp.eval(`document.querySelector('.hist-toggle-all').click()`);
  await sleep(200);

  console.log('[OK] 一屏之内可直接答题：历史默认折叠，作答框在首屏内，可单条或全部展开');
} catch (err) {
  console.error(`[FAIL] ${err.message}`);
  exitCode = 1;
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.exit(exitCode);
