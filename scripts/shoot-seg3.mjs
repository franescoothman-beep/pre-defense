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

// ── 屏幕内答案：按**当前这一问的原文**现场组织，不按顺序、不靠关键词表 ──────
// 两次翻车记录：
//   ① session a0335b59：按顺序硬编码 A1/A2/A3 → 第 2 问是追问「波动区间实测」，
//      却答了聚合规则；第 4 问（全篇兜底判据）直接空着没答。
//   ② session bd38a4d8：改成关键词路由表后，模型问的是「evaluate 分数怎么校准」
//      「mock 回放 vs 真实 key 闭环」——关键词表覆盖不到，全部落到兜底答案上，
//      仍然是答非所问。
// 结论：真实模型的问题空间无法用有限关键词表覆盖。现在改为**用事实清单约束
// 现场组答案**——从 API 读当前这一问的原文，让模型只用清单内的事实作答，
// 数字逐个校验（清单里没有的数字一律不许出现），组不成就诚实答缺口。
const FACTS = `
【这是什么】
「预演」：上传材料 → 三位 AI 评委轮番质询 → 答辩风险报告；每条结论都能一键追回原文那一句。

【材料与抽取】
- 技术文档 15 页 / 19028 字 / 386 块；PDF 用 pdfjs-dist 逐页解析。
- 一次真实抽取出来的质疑点会在 54–59 条之间浮动（实测出现过 54、56、57 条）。
- 每条质疑点带锚点：blockIdx + page? + section? + quote + kind；kind 只有 quote 和 absence 两种。
- quote 必须逐字命中原文；absence 表示"查过但没有"，走 scope 校验，不进 quote 命中率分母。

【引用命中率，全部带样本量】
- 评测集 11 / 11 条 = 100%。
- 双采样一致 3 / 3 组。
- 三份真实材料 79 / 91 条 = 86.8%（论文 18/19、简历 5/5、狗粮 56/67）。
- 诚实边界：这些数字证明的是管道和机检在生效，不是命中率已经稳定。

【risk_score 材料风险分，越大越糟】
- 由服务端从 claims 聚合，纯函数 lib/report.ts 的 aggregateMaterialRisk，没有任何模型参与。
- 三条规则：① 按维度分组、每组各算 0–100；② 每条质疑点先归一到 0–1，公式 (risk-1)/4，risk 是 1–5 的整数；③ 按可信度加权平均——逐字命中权重 1.0、缺失类 0.8、引用没校验过的 0.5。
- "恒定"的准确说法：给定同一批质疑点，分数可复算；claims 本身是模型抽的，重抽会变，这一层不恒定。

【performance 临场表现分，越大越好】
- 由模型出分，四维 logic / evidence / depth / expression，5 分制。
- 5 分制锚点写死在 lib/prompts/evaluate.v1.ts：0 空答 / 1 基本没接上 / 2 明显绕开 / 3 方向对但含糊 / 4 成立差一处 / 5 答清了。
- 人工对齐：做了 12 / 12 条人工判断回填，靠锚点对齐；样本量只有 12 条，不是统计意义上的相关性分析。
- 与 risk_score 严格分开：不同名、不同颜色映射，极性和量纲都不同。

【子串匹配与四层复试】
- quote 少于 8 个字直接判不合法，schema 层就拦掉，不进命中率分母。
- 8–15 字之间仍可能误命中（比如"我们认为"这类常见短语），这是已知边界。
- 四层复试：原地命中 / 邻域 ±2 块 / 全篇兜底（单独标注，不跟原地命中混算）。
- y 容差 2.5 是标定出来的（scripts/calibrate-y-tolerance.mjs 加 2 条回归）。

【追问收敛与席位】
- 何时追问、何时收口由 lib/state.ts 的纯函数决定，不交给模型自觉。
- quick 档默认 3 位评委 × 1 主问，3–6 轮出报告；full 档最多 15 轮；任何时刻可以"结束并出报告"。
- 席位由 planSeats 按材料 claims 的维度分布排（维度按条数降序），第一问落在第一席位，所以换一次抽取顺序可能变。

【复练两条路】
- drill：同材料练回答，只比临场表现，故意不显示风险分差。
- revise：上传改后的新材料重审，才比 risk_score 和质疑点增删（之前实测 12 条降到 3 条）。

【真实 key 实测，不是只有 mock】
- 真实模式下跑过多次完整闭环：阶段 4 端到端 31/31、阶段 5 端到端 36/36。
- 11-15 用真实 key 重录过一整场：五次作答判分均值 3.2，报告的三个材料风险分是 logic 62 / evidence 58 / depth 55。
- 现在这一场录制本身就是真实模式（顶部切换条选「真实 · 实时模型」），抽取和判分都是真实调用，不是回放。
- MOCK 回放只是给评委零 key 复现用的第二条路，不是唯一路径；两个模式在同一个产品里并存，可随时切换。

【复现与工程】
- MOCK 三个前提：序号驱动回放、只允许内置样例、常驻"MOCK 演示模式"角标。
- 空目录实测：clone 5.4s、npm i 108.6s 装 79 个包、npm run demo 4.4s 就绪。
- 单测 467 条全绿；fixture 校验 51 项 0 失败。
- 技术栈：Next.js 15.5.28、TypeScript、Tailwind v4、node:sqlite（Node 24 内置）、zod 4.6.7。
- 安全基线 S1–S6；不用 dangerouslySetInnerHTML 渲染模型输出。
- SSE 流式加扫读思考态（BLOCK x/y 光带）。
- Prompt 演进证据在 docs/prompt-eval/，三组 v1 vs v2 同输入对比，18 次真实调用。

【已知局限（技术文档 §6.1 逐条写了，问到就承认并说清现状）】
- 三位 AI 评委的质询质量没做过对照评估：只有三份使用记录的定性观察，定量对照要人工标注基线，成本超出预算。
- absence 类样本极少，只有 1 条：缺失类覆盖率是 100%，但建立在一个样本上，统计意义弱。
- 超长材料 quote 命中率会降：476 块的材料上是 83.6%（56/67），因为块号误差超出 ±2 邻域。
- 模型输出不能逐字复现：performance 场间有波动，用双采样交代幅度，不假装消除。
- PDF 覆盖不完整：扫描件、双栏、复杂表格不支持，README 里写明了。
- 单机 sqlite，不考虑并发写。

【判分卡上能看到的东西】
- 每次判分同时给 gaps（缺口）和 locators（引用定位）；引用是否通过机检单独标「出处已机检」。
- 追问由 lib/state.ts 决定：上一答含糊、缺口没填上才咬住再问一次，收敛了就翻页。

【没实测过的，问到就承认】
- 大规模人工评分的相关性和一致性统计（只有 12 条回填）。
- claims 重抽的大样本波动区间实测（只跑过双采样，claims 一致）。
- 移动端只做到 400px 不横向溢出，没有做移动端 App。
`;

/** 从 .env.local 读运行时 key（脚本不把 key 写进代码） */
function readEnvLocal() {
  const p = '.env.local';
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 数字校验：答案里出现的每个数字都必须能在事实清单里找到，否则视为编造 */
function digitsOk(answer) {
  const nums = String(answer).match(/\d+(?:\.\d+)?/g) ?? [];
  const whitelist = new Set(['1', '2', '3', '4', '5']); // 序数/档位常见数字
  for (const n of nums) {
    if (whitelist.has(n)) continue;
    if (FACTS.includes(n)) continue;
    return { ok: false, bad: n };
  }
  return { ok: true };
}

const HONEST_FALLBACK =
  '这条我没有实测数据，文档里也没写这个数——我不编。能说的是这个机制的边界在哪，具体数字要等下一轮实测才敢报。';

/** 用当场的问题原文组答案：只用事实清单，数字逐个校验 */
async function composeAnswer(question, isFollowup) {
  const env = readEnvLocal();
  const key = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY;
  const base = (process.env.DEEPSEEK_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.MODEL ?? env.MODEL ?? 'deepseek-chat';
  if (!key) throw new Error('没有 DEEPSEEK_API_KEY，组不了答案');

  const sys = [
    '你在答辩现场，评委正在质询你做的产品「预演」。',
    '只允许使用【事实清单】里的内容回答，不许引入清单外的事实、文件、数字。',
    '要求：',
    '1) 第一句直接回答评委问的那一点，不要绕、不要复述问题；',
    '2) 接着给依据：哪个文件、哪条规则、哪个数字，数字必须与清单完全一致；',
    '3) 清单里没有的，直接说"这条我没实测过，文档里也没写这个数"，绝不编造；',
    '4) 全文不超过 120 个汉字，第一人称口语，不要小标题、不要列表、不要"作为一个AI"这类口吻；',
    '5) 绝对不要说"清单""事实清单""根据清单"这类词——你是作者在答辩，不是在做检索；',
    '6) 承认边界时不要只说"没实测过"：若【已知局限】里有对应说法，就用那个口径（承认 + 现状 + 影响），并说明它在技术文档第 6 章已经写明；',
    '7) 语气要稳，不要连用两句"我没实测过"；',
    '8) 说命中率时用"11 条全中""79/91 条 = 86.8%"这类说法，不要写成"11/11 条"。',
    '',
    '【事实清单】',
    FACTS,
    // 本场实时数字：让答案能引用屏幕上真实显示的数（抽取条数、评委顺序）
    RUN
      ? `\n【本场（正在录的这一场）实测】技术文档本次抽取了 ${RUN.claims ?? '?'} 条质疑点；本场评委出场顺序是 ${RUN.judges ?? '?'}；三个材料风险分是 ${RUN.risk ?? '（报告已出时才有）'}。`
      : '',
  ].join('\n');

  const ask = async (extra) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 400,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: `评委的问题：${question}${isFollowup ? '\n（这是对上一问的追问，要针对追问的那一点答）' : ''}${extra}` },
          ],
        }),
        signal: ctrl.signal,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`LLM ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
      return String(j.choices?.[0]?.message?.content ?? '').trim().replace(/^["「]|["」]$/g, '');
    } finally { clearTimeout(timer); }
  };

  let ans = await ask('');
  let check = digitsOk(ans);
  if (!check.ok) {
    console.log(`  [answer] 检出清单外数字「${check.bad}」，重问一次`);
    ans = await ask(`\n注意：上一版出现了事实清单里没有的数字「${check.bad}」，重写，只许用清单里的数字。`);
    check = digitsOk(ans);
    if (!check.ok) { console.log('  [answer] 仍有清单外数字，改用诚实缺口答案'); return HONEST_FALLBACK; }
  }
  if (ans.length < 20) { console.log('  [answer] 答案过短，改用诚实缺口答案'); return HONEST_FALLBACK; }
  return ans;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本场实时事实（抽取条数 / 评委顺序 / 风险分）：组答案时引用，让答案对得上屏幕 */
let RUN = null;

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

/**
 * 把 OBS 的「Chrome窗口」源绑到**本脚本自己启动的那个 Chrome**。
 *
 * 【为什么不能"只有一个 chrome.exe 窗口就绑它"】
 * 2026-11-16 实录踩到：用户自己开着一个 Chrome 窗口（比赛提交页），
 * 脚本再起一个窗口后就变成 2 个，旧逻辑直接放弃绑定；
 * 而 OBS 里那个源还绑在上一次会话的旧窗口上（`zero-key reproduction`，
 * 那个窗口早关了），录出来会是黑屏或错窗口。
 *
 * 现在按**标题正则**挑：脚本的窗口打开的是本产品页面，标题里有「预演」/「质询台」，
 * 用户自己的网页通常不含这两个词。恰好命中一个才绑，命中多个仍报错让人处理。
 */
async function pointObsAtChromeWindow(obs, preferRe = /预演|质询台|localhost:3111|127\.0\.0\.1:3111/) {
  const items = await obs.req('GetInputPropertiesListPropertyItems', {
    inputName: 'Chrome窗口', propertyName: 'window',
  }).catch(() => null);
  if (!items) { console.log('[obs] 取不到窗口列表'); return false; }
  const chromeWins = items.propertyItems.filter((w) => /chrome\.exe/i.test(w.itemName));
  const prefer = chromeWins.filter((w) => preferRe.test(w.itemName));
  if (prefer.length !== 1) {
    console.log(`[obs] ⚠ 匹配本产品页面的 chrome 窗口有 ${prefer.length} 个（总 chrome 窗口 ${chromeWins.length} 个）`);
    for (const w of chromeWins) console.log(`       ${prefer.includes(w) ? '★' : ' '} ${w.itemName}`);
    return false;
  }
  const hit = prefer[0];
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
  // 2026-11-16 事故修正：上一场在报告页「两栏→复练区」之间 CDP 连接悄悄断掉，
  // 每个 mouseWheel dispatch 吃满 60s 超时还被 .catch 吞掉，663 秒全耗在这。
  // 加总时长护栏：任何一段滚动超过 20s 直接放弃，不再连环超时。
  const deadline = Date.now() + 20000;
  const from = Number(await cdp.eval('window.scrollY')) || 0;
  const delta = targetY - from;
  if (Math.abs(delta) < 4) return;
  const dir = delta > 0 ? 1 : -1;
  let moved = 0;
  const total = Math.abs(delta);
  while (moved < total) {
    if (Date.now() > deadline) { console.log('  !! smoothScroll 超时护栏触发，跳过剩余滚动'); return; }
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
  const reportOnly = flag('--report', '');

  try {
    // ── OBS 落盘自检：先录 3 秒验证文件真的写出来，再开正式录制 ──
    // 2026-11-16 事故：干跑停止后 OBS 状态未复位，正式跑 StartRecord 静默失效，
    // 8 分钟素材全丢（StopRecord 返回空路径）。现在先验证落盘再录正片。
    await cdp.send('Page.navigate', { url: BASE + (reportOnly ? `/report/${reportOnly}` : '/upload') });
    await waitRendered(cdp, `!!document.querySelector('.drop, .frame, input')`, 25000, '上传页');
    await sleep(900);

    if (obs) {
      const bound = await pointObsAtChromeWindow(obs);
      await sleep(1200);
      if (!bound) console.log('[obs] ⚠ 未绑定成功');
      // 自检：3 秒录制 → 停 → 验证 outputPath 非空
      const test = await obs.req('StartRecord');
      await sleep(3000);
      const testStop = await obs.req('StopRecord');
      const testPath = testStop?.outputPath;
      if (!testPath) throw new Error(`OBS 落盘自检失败（StartRecord=${JSON.stringify(test)}，StopRecord=${JSON.stringify(testStop)}）——先手动检查 OBS 再跑`);
      console.log(`[obs] 落盘自检 OK → ${testPath}`);
      await sleep(800);
      // 删除自检产物，避免垃圾文件
      try { fs.rmSync(testPath, { force: true }); console.log('[obs] 自检文件已删'); } catch {}
      await sleep(500);

      await obs.req('StartRecord');
      console.log('[obs] 正式录制已启动');
      await sleep(1400);
    }

    // ── 只录报告页尾巴（--report <sessionId>）──
    // 用途：正片段③ 里的问答已经录好，但报告页只抢到约 10 秒（第一屏/看板/两栏/复练区各 2–3 秒）。
    // 复练区（revise/drill）是必拍内容，单独补一段长尾巴，剪辑时接在报告页后面。
    // 同一个 sessionId 重开报告页，数字完全一致——不是摆拍，是同一份数据再打开一次。
    if (reportOnly) {
      await cdp.send('Page.navigate', { url: `${BASE}/report/${reportOnly}` });
      await waitRendered(cdp, `!!document.body && document.body.innerText.length > 50`, 25000, '报告页');
      await sleep(1200);
      mark('报告页第一屏');
      await sleep(4200);
      await smoothScroll(cdp, 620);
      await sleep(4200);
      mark('质询风险看板');
      await smoothScroll(cdp, 1500);
      await sleep(5200);
      mark('两栏（材料风险 / 临场表现）');
      await smoothScroll(cdp, 2600);
      await sleep(6500);
      mark('复练区（revise / drill）');
      await sleep(2000);
      return;
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
    RUN = facts;   // 让 composeAnswer 能引用本场真实数字（抽取条数 / 评委顺序 / 风险分）
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

    // ── 作答循环（真实模型，判分较慢，等待时间放宽）──
    // 2026-11-16 第二次修正：从 API 读**当前这一问的原文**（不靠 DOM 抓、不靠关键词表），
    // 现场按事实清单组答案；循环答到会话结束（ended），不留空轮。
    let answered = 0;
    let prevSt = '';
    facts.qa = [];
    for (let round = 0; round < 12; round++) {   // quick 上限 6 轮，12 是保险
      const ok = await waitAnswerable(cdp, 70000);
      if (!ok) { console.log(`  !! 第 ${round + 1} 轮作答框未就绪（可能已出报告）`); break; }

      // 读待答问题：GET /api/sessions/:id → history 里 answer 为空的那条
      let qText = '', qKind = 'question';
      try {
        const ss = await (await fetch(`${BASE}/api/sessions/${s.sessionId}`)).json();
        const pending = (ss.history ?? []).find((t) => !t.answer || t.answer === '');
        if (pending) { qText = pending.question ?? ''; qKind = pending.kind ?? 'question'; }
      } catch (e) { console.log('  !! 读题失败：' + e.message); }
      if (!qText) { console.log('  !! 读不到待答问题，停止作答'); break; }
      console.log(`  [Q${answered + 1}/${qKind}] ${qText.slice(0, 70)}`);

      let ans;
      try { ans = await composeAnswer(qText, qKind === 'followup'); }
      catch (e) { console.log('  !! 组答案失败：' + e.message); ans = HONEST_FALLBACK; }
      console.log(`  [A${answered + 1}] ${ans.slice(0, 60)}…（${ans.length} 字）`);
      facts.qa.push({ q: qText, kind: qKind, a: ans });

      mark(`第 ${answered + 1} 轮出现（${qKind === 'followup' ? '追问' : '主问'}）`);
      await sleep(1200);

      await typeHuman(cdp, ans);
      mark(`第 ${answered + 1} 轮：打完（${ans.length} 字）`);
      await sleep(700);

      const clicked = await clickAt(cdp, 'button.answer-submit', '提交并判分');
      if (!clicked) break;
      answered++;

      const st = await waitSubmitted(cdp, 70000);
      mark(`第 ${answered} 轮提交完成（${st}）`);
      prevSt = st;
      if (st === 'ended') break;
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
      '## 本场问答（核对用：题目是模型现场生成的，答案是按事实清单现场组的）',
      '',
      ...(facts.qa ?? []).flatMap((x, i) => [
        `**Q${i + 1}（${x.kind === 'followup' ? '追问' : '主问'}）**：${x.q}`,
        '',
        `**A${i + 1}**：${x.a}`,
        '',
      ]),
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

// 单题演练：node scripts/shoot-seg3.mjs --ask "评委的问题" [--followup]
// 只组答案不录制，用来在正式录之前检查答案质量（不消耗录制额度，只消耗一次对话）。
if (has('--ask')) {
  const q = flag('--ask', '');
  if (!q) { console.error('用法：--ask "问题原文" [--followup]'); process.exit(2); }
  try {
    const a = await composeAnswer(q, has('--followup'));
    console.log('\n问题：' + q + '\n答案（' + a.length + ' 字）：\n' + a);
    process.exit(0);
  } catch (e) { console.error('✖ ' + e.message); process.exit(1); }
}

main().then(() => setTimeout(() => process.exit(0), 300))
  .catch((e) => { console.error('✖ ' + e.message); setTimeout(() => process.exit(1), 300); });
