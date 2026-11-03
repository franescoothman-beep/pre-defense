// scripts/probe-mobile.mjs —— 400px 移动端横向溢出回归探针
//
// 【为什么固化这个脚本】
// 11-02 修移动端横向溢出时用的是**一次性**探针，修完就删了
// （progress.md:500 挂的账：「400px 探针是一次性脚本已删，日后若要回归移动端建议固化进 scripts/」）。
// 没有回归脚本的后果：之后任何一次 UI 改动都可能悄悄把某个页面重新撑宽，
// 而宽屏上肉眼根本看不出来——横向溢出只在窄视口、且只有滚动条那个像素级证据。
// 这个脚本就是那笔账的还款：一条命令跑完全部「有真实数据」的页面。
//
// 【为什么用 CDP，而不是 --window-size 或 iframe】
// 11-02 实测走过两条弯路（progress.md:494-495），两条都记在这里，别再走一遍：
//   ① `--window-size=400` + `--screenshot`：无头 Edge 的窗口宽有下限，
//      **截图里"被切"是裁出来的假象，不是真 400px 视口**。拿它量移动端布局等于没量。
//   ② iframe 探针：能跑通（11-02 就是靠它定位到 `.ribbon` / `.mock-banner`），
//      但跨源要开 `--disable-web-security`，属于为了量尺寸而拆安全栏杆。
// 所以这里用 CDP + `Emulation.setDeviceMetricsOverride`——这是**唯一**能拿到真实 400px 视口的办法。
// 11-02 说「CDP 直连两次都报 CDP 未就绪」，那是**没等端口真正绑上**就去连，不是 CDP 不可用；
// 本脚本改成轮询 `/json/version` 直到就绪（最长 15s），把那个坑填掉。
//
// WebSocket 用 Node 22+ 内置的全局 WebSocket，**不新增任何依赖**。
//
// 用法：
//   node scripts/probe-mobile.mjs                    # 自动发现全部有数据的页面
//   node scripts/probe-mobile.mjs --width 360        # 换视口宽
//   node scripts/probe-mobile.mjs --path / --path /upload   # 只测指定路径
//   node scripts/probe-mobile.mjs --headful          # 开有头窗口看它怎么量（调试用）
//
// 退出码：0 = 全部无横向溢出；1 = 有页面被撑宽（这就是回归被触发的那一声）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const multi = (name) => argv.reduce((acc, a, i) => (a === name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const WIDTH = Number(flag('--width', '400'));
const HEIGHT = Number(flag('--height', '900'));
const BASE = flag('--base', 'http://127.0.0.1:3111').replace(/\/$/, '');
const EXPLICIT = multi('--path');
const PORT = Number(flag('--port', '9333'));
const HEADFUL = has('--headful');
const SELF_TEST = has('--self-test');
const DB_PATH = path.resolve(flag('--db', 'data/app.db'));

// ── 页面清单：默认从库里自动发现「有真实数据」的页面 ────────────────────
// 为什么要自动发现而不是写死路径：写死的清单会随库里数据变旧而失效
// （报告 id 每次重跑都变），探针就开始「全绿但什么都没测」。用库驱动则新报告自动纳入。
function discoverPaths() {
  if (EXPLICIT.length > 0) return EXPLICIT;

  const fixed = ['/', '/upload'];
  if (!fs.existsSync(DB_PATH)) {
    console.log(`  ⚠ 未找到 ${DB_PATH}，只测固定页（${fixed.join(' ')}）。`);
    console.log('    先跑一场 demo（npm run demo）再测，才能覆盖 doc / session / report 三类真实数据页。');
    return fixed;
  }

  const { DatabaseSync } = require_node_sqlite();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const list = [...fixed];
  try {
    // 材料页：每份「有质疑点」的材料各取一条（不同 claim 数量会撑出不同长度的卡片）
    const docs = db
      .prepare(
        `select d.id, d.name, (select count(*) from claims c where c.doc_id = d.id) as n
         from documents d
         where (select count(*) from claims c where c.doc_id = d.id) > 0
         order by d.created_at desc limit 4`,
      )
      .all();
    for (const d of docs) list.push(`/doc/${d.id}`);

    // 会话页：优先取「还没出报告」的（作答中的态最容易撑宽：输入区 + 追问 + 评审席同时在场）
    const sessions = db
      .prepare(
        `select s.id from sessions s
         where s.id not in (select session_id from reports)
         order by s.started_at desc limit 2`,
      )
      .all();
    for (const s of sessions) list.push(`/session/${s.id}`);

    // 报告页：取最新一份（看板 + 两栏 + 引用卡片是全站最宽的布局）
    const reports = db.prepare(`select session_id as id from reports order by created_at desc limit 1`).all();
    for (const r of reports) list.push(`/report/${r.id}`);
  } finally {
    db.close();
  }
  return list;
}

// node:sqlite 是内置模块，但只在需要时才导入（缺库时不该因导入失败而崩）
function require_node_sqlite() {
  // 动态 import 在这里用不了（discoverPaths 是同步的），用 createRequire 同步取。
  // 注意：本文件是 ESM，没有全局 require，必须用 createRequire(import.meta.url) 现造一个。
  return createRequire(import.meta.url)('node:sqlite');
}

// ── 浏览器 ──────────────────────────────────────────────────────────────
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function launch() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge/Chrome，无法量布局。装了任一即可。');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-mobile-'));
  const args = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    ...(HEADFUL ? [] : ['--headless=new']),
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: 'ignore', detached: false });
  return { child, profile };
}

async function wsEndpoint() {
  const deadline = Date.now() + 15_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`CDP 端口 ${PORT} 在 15s 内未就绪（${lastErr?.message ?? '无 page target'}）`);
}

// ── 极简 CDP 客户端（只用到 Runtime / Page / Emulation 三个域）──────────
function cdp(ws) {
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} 超时`));
          }
        }, 20_000);
      });
    },
    on(fn) {
      listeners.push(fn);
    },
  };
}

// ── 页内测量表达式 ──────────────────────────────────────────────────────
// 判定标准只有一条：`documentElement.scrollWidth > clientWidth` 就是有横向滚动条。
// 另外列出「右边界超出视口」的元素，用来直接告诉人**是谁**撑宽的（没有这一步，
// 只知道"被撑宽了"却要重新排查，正是 11-02 第一次判错成 `.tagline` 的成因）。
const MEASURE = `(() => {
  const de = document.documentElement;
  const clientW = de.clientWidth;
  const scrollW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const cssPath = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      if (typeof n.className === 'string' && n.className.trim()) {
        const cls = n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
        if (cls) s += '.' + cls;
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const offenders = [];
  if (document.body) {
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right > clientW + 0.5) {
        offenders.push({
          sel: cssPath(el),
          right: Math.round(r.right),
          width: Math.round(r.width),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
        });
      }
    }
  }
  offenders.sort((a, b) => b.right - a.right);
  return JSON.stringify({
    clientW: clientW,
    scrollW: scrollW,
    textLen: document.body ? document.body.innerText.length : 0,
    // 骨架屏判定：这些文案出现在正文里，说明数据还没回来，此时量布局等于没量。
    // 11-02 的后继教训——报告页骨架「正在读取报告…」只有 47 字，但它**是稳定的**，
    // 所以「正文长度连续不变」不能当渲染完成的判据，必须显式排除骨架态。
    skeleton: /正在读取报告|正在加载|加载中|正在解析|正在抽取|正在排席位|正在生成报告|正在发言/.test(
      document.body ? document.body.innerText : '',
    ),
    offenderCount: offenders.length,
    offenders: offenders.slice(0, 5),
  });
})()`;

// ── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  // 先确认服务在跑——探针量的是"渲染结果"，服务不在就只是一堆 ERR_CONNECTION_REFUSED
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error(`status=${h.status}`);
    const j = await h.json();
    console.log(`服务：${BASE} · mock=${j.mock}`);
  } catch (e) {
    console.error(`✖ 连不上 ${BASE}/api/health（${e.message}）`);
    console.error('  先起服务：npm run demo（零 key，MOCK 模式）');
    process.exit(1);
  }

  const paths = discoverPaths();
  console.log(`视口：${WIDTH}×${HEIGHT} · 待测 ${paths.length} 个页面`);
  console.log('─'.repeat(74));

  const { child, profile } = launch();
  const cleanup = () => {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    // 浏览器 profile 目录是临时的，留着没意义；Windows 上偶尔有句柄残留，失败不影响结论
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  };
  process.on('exit', cleanup);

  const wsUrl = await wsEndpoint();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  const c = cdp(ws);

  await c.send('Page.enable');
  await c.send('Runtime.enable');
  // 真实 400px 视口：这一行就是 11-02 用 `--window-size` 拿不到的东西
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: true,
  });

  // 页面加载完成的信号：Page.loadEventFired。但客户端组件在 load 之后才 fetch 数据，
  // 所以 load 只是起点，真正开测要等正文长度稳定（下面 pollStable）。
  let loadResolve = null;
  c.on((m) => {
    if (m.method === 'Page.loadEventFired' && loadResolve) {
      const r = loadResolve;
      loadResolve = null;
      r();
    }
  });

  const results = [];
  for (const p of paths) {
    const url = BASE + p;
    await new Promise((res) => {
      loadResolve = res;
      c.send('Page.navigate', { url }).catch(() => res());
      // 导航失败（比如 404）也要往下走，靠下面超时兜底
      setTimeout(res, 15_000);
    });

    // 等「真实内容」出现，而不是等「正文长度稳定」。
    // 11-02 的后继教训：报告页的骨架「正在读取报告…」只有 47 字，而**骨架本身就是稳定的**，
    // 所以「连续 N 次长度不变」会把骨架屏判成渲染完成（第一版就是这么 9/9 全绿却漏掉报告页的）。
    // 现在的判据有三条，缺一不可：
    //   ① 正文长度稳定（客户端组件不再变）
    //   ② **不在骨架态**（页面里没有「正在读取 / 正在解析 / 正在发言…」这类进行中文案）
    //   ③ 已经等了至少 1.2s（防止 SSR 首帧就稳定、JS 还没跑）
    const started = Date.now();
    let prev = -1;
    let stable = 0;
    let last = null;
    let measured = false;
    while (Date.now() - started < 25_000) {
      const { result } = await c.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      last = JSON.parse(result.value);
      const ready = !last.skeleton && last.textLen > 200 && Date.now() - started > 1200;
      if (ready && last.textLen === prev) stable++;
      else stable = 0;
      prev = last.textLen;
      if (stable >= 4) {
        measured = true;
        break; // 连续 4 次（≈800ms）正文稳定且非骨架 → 认定渲染完成
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const overflow = last.scrollW > last.clientW;
    // 没测到真实内容 = 没测。不许当通过（这正是第一版的 bug）。
    const unmeasured = !measured;

    // ── 负向对照（--self-test）────────────────────────────────────────
    // 目的：证明"这个探针真的会报错"。一个永远输出 ✔ 的探针等于没有探针——
    // 它既可能因为测试方法失效（量了假视口），也可能因为判定条件写反。
    // 做法：在当前页面注入一个必然撑宽的元素，重测一次，**必须**测出溢出；
    // 然后移除它，确认恢复绿。两步都过，才说明探针的判定链路是活的。
    let selfTestOk = null;
    if (SELF_TEST) {
      await c.send('Runtime.evaluate', {
        expression: `(() => {
          const d = document.createElement('div');
          d.id = '__probe_self_test__';
          d.style.cssText = 'position:absolute;top:0;left:0;width:${WIDTH + 200}px;height:8px;background:red;';
          d.textContent = 'self-test';
          document.body.appendChild(d);
        })()`,
      });
      const { result: injected } = await c.send('Runtime.evaluate', {
        expression: MEASURE,
        returnByValue: true,
      });
      const inj = JSON.parse(injected.value);
      const caught = inj.scrollW > inj.clientW;
      await c.send('Runtime.evaluate', {
        expression: `document.getElementById('__probe_self_test__')?.remove()`,
      });
      selfTestOk = caught;
      console.log(
        `   [自检] 注入 ${WIDTH + 200}px 元素 → ${caught ? '✔ 探针测出了溢出（判定链路是活的）' : '✖ 探针没测出注入的溢出（这个探针不可信，先修它）'}`,
      );
    }

    results.push({ path: p, ...last, overflow, unmeasured, selfTestOk });

    const mark = unmeasured ? '⚠' : overflow ? '✖' : '✔';
    const note = unmeasured ? `  ⚠ 仍是骨架态（${last.skeleton ? '进行中文案在' : '正文仅 ' + last.textLen + ' 字'}），未测到真实布局` : '';
    console.log(`${mark} ${p.padEnd(46)} clientW=${last.clientW} scrollW=${last.scrollW} 正文${last.textLen}字${note}`);
    if (overflow) {
      console.log(`     被撑宽的元素（右边界 > ${last.clientW}，共 ${last.offenderCount} 个）：`);
      for (const o of last.offenders) {
        console.log(`       right=${o.right} width=${o.width}  ${o.sel}`);
        if (o.text) console.log(`                                   「${o.text}」`);
      }
    }
  }

  ws.close();
  const bad = results.filter((r) => r.overflow);
  const unmeasured = results.filter((r) => r.unmeasured);
  console.log('─'.repeat(74));
  console.log(`判定：${results.length - bad.length - unmeasured.length} / ${results.length} 个页面无横向溢出（视口 ${WIDTH}px）`);
  if (unmeasured.length > 0) {
    console.log('');
    console.log(`⚠ 有 ${unmeasured.length} 个页面没测到真实内容（仍是骨架态）：`);
    for (const u of unmeasured) console.log(`    ${u.path}`);
    console.log('  这类"没测到"不能算通过。常见原因：');
    console.log('   · 该路径的接口报错 → 页面停在骨架（先看开发者工具 Network）');
    console.log('   · 该页面确实没有内容（如未出报告的会话、0 条 claims 的材料）→ 换一条有数据的记录');
    console.log('   · 渲染真的很慢 → 加 --timeout 或先确认服务没在冷启动');
  }
  if (bad.length > 0) {
    console.log('');
    console.log('有页面被撑宽。定位顺序照 11-02 的教训来：');
    console.log('  1. 看上面列出的 `sel`，那是**实测右边界超标**的元素，不要凭直觉猜（11-02 第一版猜 .tagline 就猜错了）');
    console.log('  2. 常见成因是单行 flex 不换行 —— 加 flex-wrap: wrap / min-width: 0');
    console.log('  3. 修完必须重跑本脚本，全部页面全绿才算修好');
  }
  cleanup();
  // 退出码：溢出优先（真问题），其次"没测到"（探针自己没跑好，同样算失败）
  const selfTestFail = SELF_TEST && results.some((r) => r.selfTestOk === false);
  process.exit(bad.length > 0 || selfTestFail ? 1 : unmeasured.length > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error('✖ 探针失败：', e?.message ?? e);
  process.exit(1);
});
