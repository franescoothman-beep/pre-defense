// scripts/shoot-seg2.mjs —— 段②（quick 完整预演）自动录制
//
// 【它干什么】
//   OBS 起录 → 用 CDP 驱动 Edge 真实操作页面（点击 / 逐字打字 / 滚动）→ OBS 停录 → ffprobe 验收。
//   全程按《录制全案.md §5》的分镜走，不再即兴。
//
// 【为什么打字要"逐字"而不是一次填满】
//   段② 的价值有一半是"这台机器上真的有人把这个流程走完了"。
//   一次 setValue 填满，镜头里看起来像粘贴，且 DoD 里"人手走完"的说法站不住。
//   这里按 55–95ms/字的随机节奏逐字输入（≈12–18 字/秒），并按标点插入自然停顿。
//   注意：这是脚本模拟的"人手速度"，**不等于**人工验收——真要那一条，得真人自己敲。
//
// 【为什么答案是要从《录制全案》抄，不在这里另写一份】
//   屏上打的每一句都必须与 fixtures/llm/evaluate.json 里那份真实判分对得上；
//   答案一改，判分卡就会自相矛盾（屏幕上写着"会切留出集"，判分卡写"未回答"）。
//   所以答案常量集中在本文件顶部，与录制全案 §5.3 逐字一致，改一处要两处同步。
//
// 用法：
//   node scripts/shoot-seg2.mjs                 # 录制 + 验收
//   node scripts/shoot-seg2.mjs --dry           # 只走流程不录（排查选择器）
//   node scripts/shoot-seg2.mjs --base http://127.0.0.1:3111
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
const W = 2560;
const H = 1600;
const CDP_PORT = 9337;
const OBS_PW = process.env.OBS_WS_PASSWORD ?? '4SzYEEqWT9rZhPv6';

// ── 屏幕内答案：与《录制全案.md §5.3》逐字一致 ────────────────────────────
const A_MAIN1 =
  '这一问我们确实考虑了。800 条评测集在多轮调优里反复用过，96.8% 正是调在这同一批上算的，' +
  '存在过拟合，会切出独立留出集；目前没有把评测集和调优分开，这是这份材料最大的风险点之一。';
const A_FOLLOW1 =
  '目前一条都没划：800 条全部参与了多轮调优，96.8% 就是在这 800 条全部上算的，没有留出集。' +
  '所以这个数字只能说明在调过的数据上拟合得住，泛化性没有被验证——这是这份材料的硬伤，我认。' +
  '下一版会在调优前先把一部分锁住不动，调完再在这部分上报一次。';
const A_MAIN2 =
  '目前没有显式的拒答阈值：检索为空或片段不相关时，靠提示词要求「无依据就不答」，' +
  '模型仍可能脱离片段生成。这是设计上的缺口，下一版会加阈值判断兜底。';
const A_FOLLOW2 =
  '消融那组没有改提示词：约束原样保留，只是检索为空，所以那组很多题是靠拒答或空答撑过去的。' +
  '这让消融不干净——去掉检索之后，模型仍被同一条约束按住，测出来的不是「没有检索的模型有多强」，' +
  '而是「没有检索时这套提示词还剩多少」。下一版会把两组提示词分开写。';
const A_MAIN3 =
  '中间缺的是跨域验证这一步：目前只在教务一个域上评测过，政务、医疗的差异' +
  '（术语、问题分布、语料结构）都没有实测数据，推广结论目前是展望不是结论。';

const ANSWERS = [A_MAIN1, A_FOLLOW1, A_MAIN2, A_FOLLOW2, A_MAIN3];

// ── OBS 控制 ────────────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

class Obs {
  constructor() {
    this.id = 0;
    this.pending = new Map();
  }
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
        } else if (m.op === 2) {
          clearTimeout(t);
          resolve();
        } else if (m.op === 7) {
          const p = this.pending.get(m.d.requestId);
          if (p) {
            this.pending.delete(m.d.requestId);
            m.d.requestStatus?.result ? p.res(m.d.responseData ?? {}) : p.rej(new Error(m.d.requestStatus?.comment));
          }
        }
      });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('OBS websocket 连不上（OBS 没开？）')); });
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

// ── CDP ────────────────────────────────────────────────────────────────
// 【为什么默认用 Chrome 而不是 Edge】
// 两者都能跑，实测成片字号完全一致（都是 CSS 13.5px × dpr 1.875 × 1920/2560 = 19.0px）。
// 选 Chrome 是因为它的窗口 chrome 高度更接近窗口真实边界（1364×726 vs Edge 1356×729），
// 且 `Browser.setWindowBounds` 的 maximize 行为更干脆——录制口径要求"尽可能大的可视区"。
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

// 【缩放口径：这一条决定成片字号与"能不能一屏看全"，改之前先读《录制全案.md §1.1》】
// 本机物理 2560×1600 + Windows 150%。要复现文档里"125% 缩放"的效果，
// 直接传 --force-device-scale-factor=1.875（= 1.5 × 1.25）。
//
// 【窗口尺寸为什么是 1707×1067 而不是 start-maximized】
// 实测三种方式（同一台机器、同一 DSF）：
//   --start-maximized        → inner 1364×726，质疑点页每列只露 2 张完整卡（可视 373px）← 用户反馈"看不全"
//   --kiosk                  → inner 1366×854，每列 3 张（可视 501px），但没有地址栏、看不到 URL
//   --window-size=1707,1067  → inner 1366×774，每列 3 张（可视 421px），且保留地址栏  ← 采用
// 1707×1067 就是 Windows 缩放 150% 下的 CSS 屏幕尺寸，等于"把窗口撑满屏幕但仍带 chrome"。
// 再往上加窗口高度没有效果（已到屏幕物理上限），所以 774 是带地址栏时的最大值。
const WIN_W = flag('--win-w', '1707');
const WIN_H = flag('--win-h', '1067');
const DSF = flag('--dsf', '1.875');

function launchBrowser() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-'));
  const child = spawn(exe, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIN_W},${WIN_H}`,
    '--window-position=0,0',
    `--force-device-scale-factor=${DSF}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebarV2',
    '--hide-crash-restore-bubble',
    '--autoplay-policy=no-user-gesture-required',
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
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('CDP 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
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
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error(method + ' 超时'))), 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真人节奏逐字输入：带随机间隔 + 标点后停顿 */
/**
 * 真人节奏逐字输入（走浏览器真实输入通道，不是 setValue）
 *
 * 【为什么从 setValue 改成 Input.insertText】
 * 旧实现是 `setter.call(ta, ta.value + ch)` + 派发 `input` 构造事件 —— 那是**在 React 层面骗过去**，
 * 浏览器并不认为发生过输入：焦点环不动、光标不闪、不触发 beforeinput/composition。
 * 录出来只有文字在变，别的一切静止，细看就知道不是人在打。
 *
 * `Input.insertText` 是 CDP 的 IME 提交语义：浏览器按"输入法上屏"处理，
 * 会走真实的 beforeinput → input 链路、移动插入符、更新选区。实测中文与 ASCII 都能进。
 *
 * 【为什么不用 Input.dispatchKeyEvent】
 * 也行（实测 text='中' 能上屏），但中文没有对应的物理键位，
 * 只能硬编一个 code，一旦哪天撞上浏览器快捷键就出怪事。insertText 没有这个风险。
 *
 * 【诚实的边界】这条路径不会让 Windows 屏幕上出现"软键盘"或键位叠加层——
 * 那要有额外的 overlay 软件。它做到的是"浏览器认为是真输入"，不是"桌面上有个键盘"。
 */
async function typeHuman(cdp, text) {
  // 先聚焦并清空（清空这一步仍用 setter，因为要保证起点干净）
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
    // 真实输入通道：IME 提交一个字
    await cdp.send('Input.insertText', { text: ch }).catch(() => {});
    let delay = 45 + Math.random() * 55; // 45–100ms/字
    if ('，。；：！？'.includes(ch)) delay += 220 + Math.random() * 180;
    if ('、'.includes(ch)) delay += 90;
    await sleep(delay);
  }
}

/**
 * 用真实滚轮把页面滚到目标位置（而不是 window.scrollTo 瞬移）
 *
 * 【为什么要这么做】录屏里 scrollTo 是一步跳到位的，观众看到的是"画面突然换了"；
 * 真人翻页是一次次 wheel 事件累积起来的，有加速感与惯性。
 * 这里按"每次 100px、间隔 40ms"发 wheel，接近真人一次滑动。
 */
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
      type: 'mouseWheel',
      x: 960,
      y: 700,
      deltaX: 0,
      deltaY: d,
      button: 'none',
      buttons: 0,
    }).catch(() => {});
    moved += Math.abs(d);
    await sleep(gapMs);
  }
}

/**
 * 窗口采集：把 OBS 的采集源指向本次脚本自己开出来的那个 Chrome 窗口
 *
 * 【为什么必须换成窗口采集，不能用显示器采集】
 * 显示器采集抓的是"屏幕上最前面的东西"。第一次录段② 时，OBS 窗口和对话窗口
 * 在录制期间被带到前台，整屏采集把它们一起录进了成片（33s 处能看到 OBS 界面与聊天窗）。
 * 窗口采集（method=2 = WGC）只抓目标窗口**内容**，即使它被完全挡住也照抓。
 *
 * 【为什么按 exe 名找，而不是按标题找】
 * 试过两条更"精确"的路，都不成：
 *   ① 改 document.title 加唯一标记 —— OBS 的窗口列表是**静态快照**，
 *      改完标题它不会刷新，标记永远匹配不到（实测日志：找不到标记 SEG2-xxx）。
 *   ② 按窗口标题匹配 —— 新旧 Chrome 窗口标题可能一模一样，会抓错人。
 * 最终用最简单的判据：**窗口列表里唯一那个 chrome.exe**。
 * 前提是录制前把其它 Chrome 窗口都关掉（调用方负责），这样它就只可能指向脚本这个。
 * 找不到或找到多个时**明确报警**，不静默沿用上一个源（那会静默录到别人的窗口）。
 */
async function pointObsAtChromeWindow(obs) {
  const items = await obs.req('GetInputPropertiesListPropertyItems', {
    inputName: 'Chrome窗口',
    propertyName: 'window',
  }).catch(() => null);

  if (!items) {
    console.log('[obs] 取不到窗口列表');
    return false;
  }

  const chromeWins = items.propertyItems.filter((w) => /chrome\.exe/i.test(w.itemName));
  if (chromeWins.length !== 1) {
    console.log(`[obs] ⚠ chrome.exe 窗口有 ${chromeWins.length} 个，无法确定该抓哪个：`);
    for (const w of chromeWins) console.log(`       ${w.itemName}`);
    console.log('       请先关掉其它 Chrome 窗口再录');
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

/** 等页面真正"有内容"，而不是等一个固定秒数 */
async function waitRendered(cdp, checkExpr, maxMs = 30000, label = '') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    try {
      const v = await cdp.eval(checkExpr);
      last = v;
      if (v === true) return true;
    } catch { /* 导航中，忽略 */ }
    await sleep(250);
  }
  console.log(`  ⚠ 等待超时${label ? '：' + label : ''}（最后取值 ${JSON.stringify(last)}）`);
  return false;
}

/** 等页面进入「可作答」态 */
async function waitAnswerable(cdp, maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await cdp.eval(`(() => {
      const ta = document.querySelector('textarea.answer-input');
      const btn = document.querySelector('button.answer-submit');
      return JSON.stringify({
        hasTa: !!ta,
        disabled: ta ? ta.disabled : true,
        btnDisabled: btn ? btn.disabled : true,
      });
    })()`);
    const st = JSON.parse(s);
    if (st.hasTa && !st.disabled) return true;
    await sleep(350);
  }
  return false;
}

/** 等提交完成（按钮回到可用 / 页面出现下一问） */
async function waitSubmitted(cdp, beforeQ, maxMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await cdp.eval(`(() => {
      const ta = document.querySelector('textarea.answer-input');
      const btn = document.querySelector('button.answer-submit');
      const body = document.body ? document.body.innerText : '';
      return JSON.stringify({
        hasTa: !!ta,
        disabled: ta ? ta.disabled : true,
        btnDisabled: btn ? btn.disabled : true,
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

async function main() {
  if (!DRY) {
    const h = await (await fetch(`${BASE}/api/health`)).json().catch(() => null);
    if (!h?.ok) throw new Error(`服务连不上：${BASE}`);
    if (h.mode !== 'mock') throw new Error(`段② 必须在演示模式录（当前 mode=${h.mode}）。先切回「演示 · 零 key 回放」。`);
    console.log(`[svc] ${BASE} mode=${h.mode} ok`);
  }

  // ── OBS ──
  let obs = null;
  if (!DRY) {
    obs = new Obs();
    await obs.connect();
    const rec = await obs.req('GetRecordStatus');
    if (rec.outputActive) throw new Error('OBS 已在录制中，先停掉再跑本脚本');
    console.log('[obs] 已连接');
  }

  // ── 浏览器 ──
  const { child, profile } = launchBrowser();
  const wsUrl = await cdpReady();
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 【这里刻意不调 Browser.setWindowBounds 最大化】
  // 最大化会覆盖 --window-size，把可视高从 774 压回 726（浏览器自己加回标签栏/地址栏盒子
  // 的另一套尺寸），质疑点页每列就只剩 2 张完整卡 —— 正是用户看到的"看不全"。
  // 窗口尺寸只由 --window-size 决定，见文件头那段对照表。
  await sleep(1000);
  console.log('[cdp] 已连接');

  const timeline = [];
  const mark = (label) => {
    const t = Date.now();
    timeline.push({ label, t });
    console.log(`  · ${label}`);
  };
  const t0 = Date.now();

  // 起录前把 OBS 的采集源绑到"本次这个 Chrome 窗口"。
  //
  // 【顺序很关键】必须先把页面导航到首页，**再**绑窗口、再开录。
  let windowBound = false;

  // 记下真实视口与字号，写进时间线文件（成片字号是硬指标，随手留证）
  // 【必须等首页加载完再量】在 about:blank 上量，选择器一个都匹配不到，fontCss 会是 undefined。
  let viewport = null;
  const measureViewport = async () => {
    const vp = await cdp.eval(`(() => {
      const el = document.querySelector('.lede, .ds, .tagline, p, li');
      return JSON.stringify({
        innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
        fontCss: el ? parseFloat(getComputedStyle(el).fontSize) : null,
      });
    })()`).catch(() => null);
    if (!vp) return null;
    const v = JSON.parse(vp);
    if (!v.fontCss) return v;
    v.finalPx = (v.fontCss * v.dpr * (1920 / 2560)).toFixed(1);
    return v;
  };

  try {
    // 先把首页导航完，再绑窗口，最后才开录（顺序错会录到上一个窗口的残留）
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await waitRendered(cdp, `!!document.querySelector('.flow, .proof, main') && document.body.innerText.length > 200`, 25000, '首页');
    await sleep(900);

    if (obs) {
      // 【必须在 StartRecord 之前】录制开始后再切源，成片开头会留着旧窗口的画面。
      windowBound = await pointObsAtChromeWindow(obs);
      await sleep(1200); // 给 WGC 一点时间建立首帧，否则开头可能是一帧黑
      if (!windowBound) {
        console.log('[obs] ⚠ 未绑定成功 —— 成片可能抓错窗口。建议先关掉其它 Chrome 再跑。');
      }
    }

    // ── 起录 ──
    if (obs) {
      await obs.req('StartRecord');
      console.log('[obs] 录制已启动');
      await sleep(1400); // 留开头余量，剪辑时好切
    }

    await sleep(1400); // 首页停住让人看清 + 旁白压画面
    mark('首页');

    // 首页渲染完再量视口/字号（这时候才有可测的正文元素）
    viewport = await measureViewport();
    if (viewport?.finalPx) {
      console.log(`[viewport] ${viewport.innerW}×${viewport.innerH} dpr=${viewport.dpr} → 成片正文 ${viewport.finalPx}px`);
      if (Number(viewport.finalPx) < 18) console.log('[viewport] ⚠ 成片字号 <18px，检查 DSF 是否为 1.875');
    } else if (viewport) {
      console.log(`[viewport] ${viewport.innerW}×${viewport.innerH} dpr=${viewport.dpr}（未取到字号）`);
    }

    // 2) 上传页
    await cdp.send('Page.navigate', { url: BASE + '/upload' });
    await waitRendered(cdp, `!!document.querySelector('.drop, .frame, textarea, input') && document.body.innerText.length > 120`, 25000, '上传页');
    await sleep(1800);
    mark('上传页');

    // 3) 质疑点页 —— 必须等 17 条卡片真的渲染出来，否则会录到一个空页面
    const demo = await (await fetch(`${BASE}/api/demo`)).json();
    if (!demo?.docId) throw new Error('拿不到内置样例 docId');
    console.log(`[demo] docId=${demo.docId} claims=${demo.claims}`);
    await cdp.send('Page.navigate', { url: `${BASE}/doc/${demo.docId}` });
    await waitRendered(
      cdp,
      `document.querySelectorAll('.card').length >= 3 && !/开始抽取质疑点/.test(document.body.innerText)`,
      35000,
      '质疑点页卡片',
    );
    await sleep(2000);
    const cardCount = await cdp.eval(`document.querySelectorAll('.card').length`);
    console.log(`  卡片数 ${cardCount}`);
    mark('质疑点页');

    // 滚到卡片区（页面已渲染完才滚，避免滚了个空壳）
    // 用真实滚轮事件而不是 window.scrollTo：录屏里滚动是有惯性、一格格走的，
    // scrollTo 是瞬移，观感差别很明显。
    await smoothScroll(cdp, 300);
    await sleep(1200);
    mark('滚到质疑点卡片');

    // 点开一条 quote 的「展开原文」（拍手锚点①）
    // 同样走真实鼠标：先滚到视野中央，再移指针、按下、抬起。
    const target = await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(x => /展开原文|查看原文/.test(x.innerText || '') && !x.disabled);
      if (!b) return 'none:' + btns.map(x=>(x.innerText||'').trim()).filter(Boolean).slice(0,12).join('|');
      b.scrollIntoView({block:'center'});
      const r = b.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    })()`);
    console.log('  quote →', typeof target === 'string' && target.startsWith('{') ? '找到按钮' : target);

    if (typeof target === 'string' && target.startsWith('{')) {
      const pos = JSON.parse(target);
      await sleep(600); // 等滚动停稳再点，否则点到的还是旧坐标
      const pos2 = await cdp.eval(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => /展开原文|查看原文/.test(x.innerText || '') && !x.disabled);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
      })()`);
      const p = pos2 ? JSON.parse(pos2) : pos;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
      await sleep(220);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(80);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      console.log('  已真实点击「展开原文」');
    }
    await sleep(2800); // 让高亮与展开动画走完
    mark('点开原文高亮');

    // 4) 开质询
    const created = await (await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: demo.docId, mode: 'quick' }),
    })).json();
    if (!created?.ok) throw new Error('建会话失败：' + JSON.stringify(created));
    console.log(`[session] ${created.sessionId} 评委 ${created.personas.length} 位`);
    await cdp.send('Page.navigate', { url: `${BASE}/session/${created.sessionId}` });
    await sleep(3600);
    mark('评审席 + 第一问');

    // 5) 五问答作（3 主问 + 2 追问）
    let answered = 0;
    for (let i = 0; i < ANSWERS.length; i++) {
      const ok = await waitAnswerable(cdp, 40000);
      if (!ok) {
        console.log(`  !! 第 ${i + 1} 问没进入可作答态，停止`);
        break;
      }
      mark(`第 ${i + 1} 问出现`);
      await sleep(1200); // 让评委的话"说完"

      await typeHuman(cdp, ANSWERS[i]);
      mark(`第 ${i + 1} 问：逐字打完（${ANSWERS[i].length} 字）`);
      await sleep(700);

      // 【提交也走真实鼠标事件】旧实现是 `b.click()`，浏览器不会移动指针也不会有按下反馈，
      // 画面里按钮"凭空生效"。这里先取按钮中心坐标，用 Input.dispatchMouseEvent
      // 真发 mouseMoved → mousePressed → mouseReleased，指针会移过去、按钮有按压态。
      const box = await cdp.eval(`(() => {
        const b = document.querySelector('button.answer-submit');
        if (!b || b.disabled) return null;
        const r = b.getBoundingClientRect();
        if (r.width === 0) return null;
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`);
      if (!box || box === 'null') {
        console.log(`  !! 第 ${i + 1} 问提交按钮不可用`);
        break;
      }
      const { x, y } = JSON.parse(box);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await sleep(160 + Math.random() * 140);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(70 + Math.random() * 60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      answered++;

      const st = await waitSubmitted(cdp, i);
      mark(`第 ${i + 1} 问提交完成（${st}）`);
      await sleep(2000); // 看判分卡
    }
    console.log(`[ans] 实际作答 ${answered} 次`);

    // 6) 出报告
    const end = await (await fetch(`${BASE}/api/sessions/${created.sessionId}/end`, { method: 'POST' })).json();
    if (!end?.ok) throw new Error('出报告失败：' + JSON.stringify(end));
    await cdp.send('Page.navigate', { url: `${BASE}/report/${created.sessionId}` });
    await sleep(4200);
    mark('报告页第一屏');

    // 滚看板 → 两栏 → 复练（真实滚轮）
    await smoothScroll(cdp, 620);
    await sleep(1800);
    mark('质询风险看板');

    await smoothScroll(cdp, 1500);
    await sleep(1900);
    mark('两栏');

    await smoothScroll(cdp, 2600);
    await sleep(1900);
    mark('复练区');
    await sleep(1500);
  } finally {
    // ── 停录 ──
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

    // 时间线写盘
    const recDir = path.join('docs', 'recordings');
    fs.mkdirSync(recDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const md = [
      `# 段② 自动录制 ${new Date().toLocaleString('zh-CN')}`,
      '',
      `- 录制文件：\`${outPath ?? '(未录)'}\``,
      `- 视口：${viewport ? `${viewport.innerW}×${viewport.innerH} · dpr ${viewport.dpr}` : '未知'} · **成片正文 ${viewport?.finalPx ?? '?'}px**`,
      `- 服务：${BASE}（演示模式）`,
      `- 总时长：${total}s`,
      '',
      '## 时间线（相对起录，秒）',
      '',
      '| 秒 | 步骤 |',
      '|---|---|',
      ...timeline.map((x) => `| ${((x.t - t0) / 1000).toFixed(1)} | ${x.label} |`),
      '',
    ].join('\n');
    const mdPath = path.join(recDir, `seg2-${stamp}.md`);
    fs.writeFileSync(mdPath, md, 'utf8');
    console.log('时间线 →', mdPath);

    try { cdp.ws.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    void ANSWERS;
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 300);
}).catch((e) => {
  console.error('✖ ' + e.message);
  setTimeout(() => process.exit(1), 300);
});
