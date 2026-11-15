// scripts/shoot-seg3.mjs —— 段③（狗粮段 · 真实模式）自动录制
//
// 【与段② 的三个关键差别】
//   1. 必须是**真实模式**（mode=real），段② 是 mock。切错了整段作废。
//   2. 要**上传文件**：technical-doc.pdf 15 页，解析 2.6s + 抽取 ≈31s，录制时得等。
//   3. 报告页数字每次都可能不同（真实模型），所以脚本不写死任何期望值，
//      只把实测值打进时间线文件，供事后核对台词。
//
// 【为什么上传走 API 而不是模拟文件选择框】
// Chrome DevTools Protocol 有 DOM.setFileInputFiles 可以真的选文件，
// 但那要求页面用的是 <input type=file> 且我们知道它的 DOM 节点。
// 更稳的做法是走产品自己的 POST /api/docs（与界面完全同一条路径），
// 然后在页面上**刷新到该 docId**，让观众看到的就是真实的质疑点页。
// 代价：上传瞬间的"进度百分比"画面看不到，所以脚本会在上传前先停 1.5s 拍上传页。
//
// 用法：
//   node scripts/shoot-seg3.mjs
//   node scripts/shoot-seg3.mjs --dry
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const BASE = flag('--base', 'http://127.0.0.1:3111').replace(/\/$/, '');
const DRY = has('--dry');
const PDF = 'docs/technical-doc.pdf';
const CDP_PORT = 9338;
const OBS_PW = process.env.OBS_WS_PASSWORD ?? '4SzYEEqWT9rZhPv6';
const WIN_W = '1707';
const WIN_H = '1067';
const DSF = '1.875';

// ── 屏幕内答案：与《段③-作答稿-实测版.md》逐字一致 ──────────────────────
const A1 =
  '这个"恒定"我要说得更准一点：恒定的是聚合这一步，不是抽取这一步。同一批 claims 进来，risk_score 每次都一样——这是纯函数，有单测钉着。但 claims 本身是模型抽的，重抽会变，我承认。所以文档里那句应该收窄成"给定同一批质疑点，分数可复算"，而不是"同一份材料永远同一个数"。';
const A2 =
  '规则是三条，都能在源码里逐条对：一、按维度分组，每组各算各的 0–100；二、每条质疑点先归一到 0–1，公式是 (risk-1)/4，risk 是 1–5 的整数；三、按可信度加权求平均——逐字命中的权重 1.0，缺失类 0.8，引用没校验过的 0.5。所以入口就一个函数，lib/report.ts 的 aggregateMaterialRisk，没有任何模型参与。';
const A3 =
  '这是个真问题。现在只有一道闸：quote 少于 8 个字直接判不合法，schema 层就拦掉了，不进命中率分母。但 8 到 15 字之间确实还会误命中——比如"我们认为"这种常见短语。所以四层复试在跑：原地命中之外还有邻域 ±2 块和全篇兜底，全篇兜底那一档我单独标出来，不跟原地命中混在一起算。';

const ANSWERS = [A1, A2, A3];

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── OBS ──
class Obs {
  constructor() { this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:4455');
      this.ws = ws;
      const t = setTimeout(() => reject(new Error('OBS 连接超时')), 10000);
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.op === 0) {
          const a = m.d?.authentication;
          const d = { rpcVersion: 1 };
          if (a) d.authentication = sha(sha(OBS_PW + a.salt) + a.challenge);
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) { clearTimeout(t); resolve(); }
        else if (m.op === 7) {
          const p = this.pending.get(m.d.requestId);
          if (p) { this.pending.delete(m.d.requestId); m.d.requestStatus?.result ? p.res(m.d.responseData ?? {}) : p.rej(new Error(m.d.requestStatus?.comment)); }
        }
      });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('OBS websocket 连不上')); });
    });
  }
  req(type, data = {}) {
    const requestId = String(++this.id);
    return new Promise((res, rej) => {
      this.pending.set(requestId, { res, rej });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId, requestData: data } }));
      setTimeout(() => this.pending.has(requestId) && (this.pending.delete(requestId), rej(new Error(type + ' 超时'))), 30000);
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function pointObsAtChromeWindow(obs) {
  const items = await obs.req('GetInputPropertiesListPropertyItems', {
    inputName: 'Chrome窗口', propertyName: 'window',
  }).catch(() => null);
  if (!items) { console.log('[obs] 取不到窗口列表'); return false; }
  const chromeWins = items.propertyItems.filter((w) => /chrome\.exe/i.test(w.itemName));
  if (chromeWins.length !== 1) {
    console.log(`[obs] ⚠ chrome.exe 窗口有 ${chromeWins.length} 个，请先关掉其它 Chrome`);
    for (const w of chromeWins) console.log(`       ${w.itemName}`);
    return false;
  }
  const hit = chromeWins[0];
  await obs.req('SetInputSettings', {
    inputName: 'Chrome窗口',
    inputSettings: { method: 2, window: hit.itemValue, capture_cursor: true, force_sdr: false },
    overlay: true,
  });
  console.log(`[obs] 已绑定窗口：${hit.itemName}`);
  return true;
}

// ── CDP ──
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function launchBrowser() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot3-'));
  const child = spawn(exe, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIN_W},${WIN_H}`,
    '--window-position=0,0',
    `--force-device-scale-factor=${DSF}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebarV2',
    '--hide-crash-restore-bubble',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
  console.log(`[browser] ${path.basename(exe)} · DSF ${DSF} · 窗口 ${WIN_W}×${WIN_H}`);
  return { child, profile };
}

async function cdpReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('CDP 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP ws 失败')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error(method + ' 超时'))), 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  }
}

async function typeHuman(cdp, text) {
  await cdp.eval(`(() => {
    const ta = document.querySelector('textarea.answer-input');
    if (!ta) return 'no-ta';
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'cleared';
  })()`);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    await cdp.send('Input.insertText', { text: ch }).catch(() => {});
    let delay = 45 + Math.random() * 55;
    if ('，。；：！？'.includes(ch)) delay += 220 + Math.random() * 180;
    if ('、'.includes(ch)) delay += 90;
    await sleep(delay);
  }
}

async function smoothScroll(cdp, targetY, step = 100, gapMs = 40) {
  const from = Number(await cdp.eval('window.scrollY')) || 0;
  const delta = targetY - from;
  if (Math.abs(delta) < 4) return;
  const dir = delta > 0 ? 1 : -1;
  let moved = 0;
  const total = Math.abs(delta);
  while (moved < total) {
    const d = Math.min(step, total - moved) * dir;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 960, y: 700, deltaX: 0, deltaY: d, button: 'none', buttons: 0,
    }).catch(() => {});
    moved += Math.abs(d);
    await sleep(gapMs);
  }
}

async function waitRendered(cdp, checkExpr, maxMs = 30000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { if ((await cdp.eval(checkExpr)) === true) return true; } catch {}
    await sleep(250);
  }
  console.log(`  ⚠ 等待超时${label ? '：' + label : ''}`);
  return false;
}

async function waitAnswerable(cdp, maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await cdp.eval(`(() => {
      const ta = document.querySelector('textarea.answer-input');
      return JSON.stringify({ hasTa: !!ta, disabled: ta ? ta.disabled : true });
    })()`);
    if (JSON.parse(s).hasTa && !JSON.parse(s).disabled) return true;
    await sleep(350);
  }
  return false;
}

async function waitSubmitted(cdp, maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await cdp.eval(`(() => {
      const ta = document.querySelector('textarea.answer-input');
      const body = document.body ? document.body.innerText : '';
      return JSON.stringify({
        hasTa: !!ta, disabled: ta ? ta.disabled : true,
        ended: /已问完|可以出报告|报告就绪|本场已结束/.test(body),
      });
    })()`);
    const st = JSON.parse(s);
    if (st.ended) return 'ended';
    if (st.hasTa && !st.disabled) return 'next';
    await sleep(400);
  }
  return 'timeout';
}

async function clickAt(cdp, selector, labelText) {
  const box = await cdp.eval(`(() => {
    const b = document.querySelector(${JSON.stringify(selector)});
    if (!b || b.disabled) return null;
    const r = b.getBoundingClientRect();
    if (r.width === 0) return null;
    return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
  })()`);
  if (!box) { console.log(`  !! 找不到可点击的 ${labelText}`); return false; }
  const { x, y } = JSON.parse(box);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(180);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  return true;
}

async function main() {
  // ── 前置 ──
  const h = await (await fetch(`${BASE}/api/health`)).json().catch(() => null);
  if (!h?.ok) throw new Error(`服务连不上：${BASE}`);
  if (h.mode !== 'real') {
    throw new Error(`段③ 必须真实模式（当前 mode=${h.mode}）。起法：$env:MOCK_LLM="0"; node node_modules/next/dist/bin/next dev -p 3111`);
  }
  console.log(`[svc] ${BASE} mode=${h.mode} ok`);
  if (!fs.existsSync(PDF)) throw new Error(`找不到 ${PDF}`);

  let obs = null;
  if (!DRY) {
    obs = new Obs();
    await obs.connect();
    const rec = await obs.req('GetRecordStatus');
    if (rec.outputActive) throw new Error('OBS 已在录制中');
    console.log('[obs] 已连接');
  }

  const { child, profile } = launchBrowser();
  const wsUrl = await cdpReady();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(1000);
  console.log('[cdp] 已连接');

  const timeline = [];
  const mark = (l) => { timeline.push({ l, t: Date.now() }); console.log(`  · ${l}`); };
  const t0 = Date.now();
  const facts = {};

  try {
    await cdp.send('Page.navigate', { url: BASE + '/upload' });
    await waitRendered(cdp, `!!document.querySelector('.drop, .frame, input')`, 25000, '上传页');
    await sleep(900);

    if (obs) {
      const bound = await pointObsAtChromeWindow(obs);
      await sleep(1200);
      if (!bound) console.log('[obs] ⚠ 未绑定成功');
    }
    if (obs) {
      await obs.req('StartRecord');
      console.log('[obs] 录制已启动');
      await sleep(1400);
    }

    await sleep(1600);
    mark('上传页（演示上传框）');

    // ── 上传 + 抽取（真实模型，约 31s）──
    const buf = fs.readFileSync(PDF);
    const boundary = '----seg3shoot' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="technical-doc.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const tUp = Date.now();
    const up = await (await fetch(`${BASE}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, buf, tail]),
    })).json();
    if (!up.ok) throw new Error('上传失败：' + JSON.stringify(up).slice(0, 200));
    facts.docId = up.docId;
    facts.pages = up.pages;
    facts.chars = up.chars;
    facts.blocks = up.blocks;
    console.log(`[upload] ${up.pages} 页 / ${up.chars} 字 / ${up.blocks} 块 · ${Date.now() - tUp}ms`);
    mark('上传完成');

    // 切到该文档页，先让它显示"正在抽取"
    await cdp.send('Page.navigate', { url: `${BASE}/doc/${up.docId}` });
    await sleep(2200);

    const tCl = Date.now();
    const cl = await (await fetch(`${BASE}/api/docs/${up.docId}/claims`, { method: 'POST' })).json();
    if (!cl.ok) throw new Error('抽取失败：' + JSON.stringify(cl).slice(0, 200));
    facts.claims = (cl.claims ?? []).length;
    facts.quoteRate = cl.quote?.rate;
    console.log(`[claims] ${facts.claims} 条 · quote ${cl.quote?.hit}/${cl.quote?.total} · ${Date.now() - tCl}ms`);
    mark(`抽取完成（${facts.claims} 条）`);

    // 刷新页面让真实结果上屏
    await cdp.send('Page.navigate', { url: `${BASE}/doc/${up.docId}` });
    await waitRendered(cdp, `document.querySelectorAll('.card').length >= 3`, 30000, '质疑点页卡片');
    await sleep(2200);
    mark('质疑点页');

    await smoothScroll(cdp, 300);
    await sleep(1300);
    mark('滚到质疑点卡片');

    // 点开一条原文（真实鼠标）
    const q = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /展开原文/.test(x.innerText || '') && !x.disabled);
      if (!b) return null;
      b.scrollIntoView({block:'center'});
      return 'ok';
    })()`);
    if (q === 'ok') {
      await sleep(700);
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => /展开原文/.test(x.innerText || ''));
        if (!b) return;
        const r = b.getBoundingClientRect();
        window.__qpos = { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        return JSON.stringify(window.__qpos);
      })()`);
      const pos = await cdp.eval('JSON.stringify(window.__qpos)');
      if (pos) {
        const { x, y } = JSON.parse(pos);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await sleep(220);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(80);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        console.log('  已点击「展开原文」');
      }
    }
    await sleep(2600);
    mark('点开原文高亮');

    // ── 开质询 ──
    const s = await (await fetch(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: up.docId, mode: 'quick' }),
    })).json();
    if (!s.ok) throw new Error('建会话失败：' + JSON.stringify(s).slice(0, 200));
    facts.sessionId = s.sessionId;
    facts.judges = s.personas.map((p) => `${p.name}(${p.role})`).join(' / ');
    console.log(`[session] ${s.sessionId.slice(0, 8)} · ${facts.judges}`);

    await cdp.send('Page.navigate', { url: `${BASE}/session/${s.sessionId}` });
    await sleep(3600);
    mark('评审席 + 第一问');

    // ── 三问作答（真实模型，判分较慢，等待时间放宽）──
    let answered = 0;
    for (let i = 0; i < ANSWERS.length; i++) {
      const ok = await waitAnswerable(cdp, 70000);
      if (!ok) { console.log(`  !! 第 ${i + 1} 问未就绪`); break; }
      mark(`第 ${i + 1} 问出现`);
      await sleep(1400);

      await typeHuman(cdp, ANSWERS[i]);
      mark(`第 ${i + 1} 问：打完（${ANSWERS[i].length} 字）`);
      await sleep(700);

      const clicked = await clickAt(cdp, 'button.answer-submit', '提交并判分');
      if (!clicked) break;
      answered++;

      const st = await waitSubmitted(cdp, 70000);
      mark(`第 ${i + 1} 问提交完成（${st}）`);
      await sleep(2200);
    }
    facts.answered = answered;
    console.log(`[ans] 实际作答 ${answered} 次`);

    // ── 报告 ──
    const end = await (await fetch(`${BASE}/api/sessions/${s.sessionId}/end`, { method: 'POST' })).json();
    if (!end.ok) throw new Error('出报告失败：' + JSON.stringify(end).slice(0, 200));
    facts.perf = (end.performance ?? []).map((p) => `${p.dimension}:${p.score ?? '—'}`).join(' ');
    facts.risk = (end.material_risk ?? []).map((m) => `${m.dimension}:${m.risk_score ?? '—'}`).join(' ');
    facts.high = (end.high_risk ?? []).length;
    console.log(`[report] perf ${facts.perf} · risk ${facts.risk} · high ${facts.high}`);

    await cdp.send('Page.navigate', { url: `${BASE}/report/${s.sessionId}` });
    await sleep(4600);
    mark('报告页第一屏');

    await smoothScroll(cdp, 620);
    await sleep(2000);
    mark('质询风险看板');

    await smoothScroll(cdp, 1500);
    await sleep(2000);
    mark('两栏');

    await smoothScroll(cdp, 2600);
    await sleep(2000);
    mark('复练区');
    await sleep(1500);
  } finally {
    let outPath = null;
    if (obs) {
      await sleep(1000);
      const res = await obs.req('StopRecord').catch((e) => ({ outputPath: null, err: e.message }));
      outPath = res.outputPath ?? null;
      console.log('[obs] 录制已停止 →', outPath ?? res.err);
      obs.close();
    }
    const total = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n总时长 ${total}s`);

    const recDir = path.join('docs', 'recordings');
    fs.mkdirSync(recDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const md = [
      `# 段③ 自动录制 ${new Date().toLocaleString('zh-CN')}`,
      '',
      `- 录制文件：\`${outPath ?? '(未录)'}\``,
      `- 服务：${BASE}（**真实模式**）`,
      `- 材料：${PDF} → ${facts.pages ?? '?'} 页 / ${facts.chars ?? '?'} 字 / ${facts.blocks ?? '?'} 块`,
      `- 质疑点：**${facts.claims ?? '?'} 条**（quote 命中率 ${facts.quoteRate != null ? (facts.quoteRate * 100).toFixed(1) + '%' : '?'}）`,
      `- 评委：${facts.judges ?? '?'}`,
      `- 作答：${facts.answered ?? 0} 次`,
      `- 报告：临场 ${facts.perf ?? '?'} · 材料风险 ${facts.risk ?? '?'} · 高风险 ${facts.high ?? '?'} 条`,
      `- 总时长：${total}s`,
      '',
      '## 时间线（相对起录，秒）',
      '',
      '| 秒 | 步骤 |',
      '|---|---|',
      ...timeline.map((x) => `| ${((x.t - t0) / 1000).toFixed(1)} | ${x.l} |`),
      '',
    ].join('\n');
    const mdPath = path.join(recDir, `seg3-${stamp}.md`);
    fs.writeFileSync(mdPath, md, 'utf8');
    console.log('时间线 →', mdPath);

    try { cdp.ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().then(() => setTimeout(() => process.exit(0), 300))
  .catch((e) => { console.error('✖ ' + e.message); setTimeout(() => process.exit(1), 300); });
