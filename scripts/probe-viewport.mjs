// scripts/probe-viewport.mjs —— 125% 缩放下「一屏装得下」回归探针
//
// 【为什么需要这个脚本】
// 录制口径是 OBS 整屏 2560×1600 → 浏览器 125%。浏览器 CSS 视口 = 2560/1.5(Win 150%)/1.25 ≈ 1365×853。
// 在这个视口里，任何页面 documentElement.scrollHeight > clientHeight 就意味着录制时要**上下滑**——
// 而「滑动」在成片里是硬伤：观众看不清你在哪、镜头会跳。
// 所以这是一个可量化的判定：scrollHeight 减去视口高 = 还得滑多少像素。
//
// 【为什么不用 --window-size】
// 同 probe-mobile.mjs 的结论：无头浏览器的窗口宽高有下限，截出来的"装不下"是假象。
// 唯一能拿到真实视口的是 CDP 的 Emulation.setDeviceMetricsOverride。
//
// 【它比 probe-mobile 多量了什么】
// 不只是「装不装得下」，还会按 DOM 顺序列出每个页面的**纵向大户**（高度 > 阈值且自己是主的块），
// 因为「滑 300px」本身不可行动，行动点是「哪一块吃了 300px」。没有这一步就只能靠猜，
// 而猜错是 11-02 横向探针第一版的教训（见 probe-mobile.mjs:190-192）。
//
// 用法：
//   node scripts/probe-viewport.mjs                  # 默认 1365×853（125% 口径）
//   node scripts/probe-viewport.mjs --height 900
//   node scripts/probe-viewport.mjs --path / --path /upload
//   node scripts/probe-viewport.mjs --top 12         # 每页列前 12 个纵向大户
//
// 退出码：0 = 全部一屏装得下；1 = 有页面要上下滑；2 = 有页面没测到真实内容。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const multi = (name) => argv.reduce((acc, a, i) => (a === name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

// 1365×853 = 2560×1600 物理屏 / Win 150% 缩放 / 浏览器 125% 缩放
const WIDTH = Number(flag('--width', '1365'));
const HEIGHT = Number(flag('--height', '853'));
const BASE = flag('--base', 'http://127.0.0.1:3111').replace(/\/$/, '');
const EXPLICIT = multi('--path');
const PORT = Number(flag('--port', '9334'));
const HEADFUL = has('--headful');
const TOP = Number(flag('--top', '8'));
const TOLERANCE = Number(flag('--tolerance', '0'));
const DB_PATH = path.resolve(flag('--db', 'data/app.db'));

function discoverPaths() {
  if (EXPLICIT.length > 0) return EXPLICIT;

  const fixed = ['/', '/upload'];
  if (!fs.existsSync(DB_PATH)) {
    console.log(`  ⚠ 未找到 ${DB_PATH}，只测固定页（${fixed.join(' ')}）。`);
    return fixed;
  }

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const list = [...fixed];
  try {
    const docs = db
      .prepare(
        `select d.id, (select count(*) from claims c where c.doc_id = d.id) as n
         from documents d
         where (select count(*) from claims c where c.doc_id = d.id) > 0
         order by d.created_at desc limit 3`,
      )
      .all();
    for (const d of docs) list.push(`/doc/${d.id}`);

    const sessions = db
      .prepare(
        `select s.id from sessions s
         where s.id not in (select session_id from reports)
         order by s.started_at desc limit 2`,
      )
      .all();
    for (const s of sessions) list.push(`/session/${s.id}`);

    const reports = db.prepare(`select session_id as id from reports order by created_at desc limit 1`).all();
    for (const r of reports) list.push(`/report/${r.id}`);
  } finally {
    db.close();
  }
  return list;
}

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function launch() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge/Chrome，无法量布局。');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-viewport-'));
  const args = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
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

// ── 页内测量 ────────────────────────────────────────────────────────────
// 判定：scrollHeight > clientHeight ⇒ 要上下滑。差值就是「还得滑多少」。
// 附带的「纵向大户」只列**自己撑高的主块**（排除祖先链上的重复计数）：
// 从 body 的第一层容器往下走一层，取可见、高度 > 40 且没有更高同类子元素的块。
const MEASURE = `(() => {
  const de = document.documentElement;
  const cssPath = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 3) {
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
  // 收集：body 直接子元素 + 每层容器里高度最大的 2 个子元素。深度限 4 层。
  const tall = [];
  const walk = (el, depth) => {
    if (!el || depth > 4) return;
    const kids = [...el.children].filter((k) => {
      const r = k.getBoundingClientRect();
      return r.height > 40 && getComputedStyle(k).display !== 'none' && getComputedStyle(k).visibility !== 'hidden';
    });
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      tall.push({
        sel: cssPath(k),
        h: Math.round(r.height),
        top: Math.round(r.top),
        depth: depth,
        tag: k.tagName.toLowerCase(),
        cls: typeof k.className === 'string' ? k.className.trim().slice(0, 60) : '',
      });
    }
    kids.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
    for (const k of kids.slice(0, 3)) walk(k, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  // 只保留「叶子级大户」：没有子元素比它更高（>80% 高度）的，才是真正占位的块
  const leaves = tall.filter((t) => !tall.some((o) => o.depth > t.depth && o.h > t.h * 0.8 && o.sel.includes(t.sel.split(' > ').pop())));
  return JSON.stringify({
    clientH: de.clientHeight,
    scrollH: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
    innerH: window.innerHeight,
    innerW: window.innerWidth,
    textLen: document.body ? document.body.innerText.length : 0,
    skeleton: /正在读取报告|正在加载|加载中|正在解析|正在抽取|正在排席位|正在生成报告|正在发言/.test(
      document.body ? document.body.innerText : '',
    ),
    tall: (leaves.length ? leaves : tall).sort((a, b) => b.h - a.h).slice(0, 24),
  });
})()`;

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error(`status=${h.status}`);
    const j = await h.json();
    console.log(`服务：${BASE} · mock=${j.mock}`);
  } catch (e) {
    console.error(`✖ 连不上 ${BASE}/api/health（${e.message}）`);
    console.error('  先起服务：npm run demo');
    process.exit(1);
  }

  const paths = discoverPaths();
  console.log(`视口：${WIDTH}×${HEIGHT}（125% 口径）· 待测 ${paths.length} 个页面 · 容许 ${TOLERANCE}px`);
  console.log('─'.repeat(78));

  const { child, profile } = launch();
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

  const wsUrl = await wsEndpoint();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  const c = cdp(ws);

  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

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
      setTimeout(res, 15_000);
    });

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
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const over = last.scrollH - last.clientH;
    const bad = over > TOLERANCE;
    results.push({ path: p, ...last, over, bad, unmeasured: !measured });

    const mark = !measured ? '⚠' : bad ? '✖' : '✔';
    const note = bad ? `  ← 要上下滑 ${over}px` : over > 0 ? `  （容差内 +${over}）` : '';
    console.log(
      `${mark} ${p.padEnd(40)} scrollH=${String(last.scrollH).padEnd(5)} 视口=${last.clientH}${note}`,
    );
    if (!measured) console.log(`     仍是骨架态或正文仅 ${last.textLen} 字，未测到真实布局`);
    if (bad) {
      for (const t of last.tall.slice(0, TOP)) {
        console.log(`       ${String(t.h).padStart(4)}px  top=${String(t.top).padStart(4)}  ${t.sel}`);
      }
    }
  }

  ws.close();
  const bad = results.filter((r) => r.bad && !r.unmeasured);
  const unmeasured = results.filter((r) => r.unmeasured);
  console.log('─'.repeat(78));
  console.log(
    `判定：${results.length - bad.length - unmeasured.length} / ${results.length} 个页面一屏装得下（${WIDTH}×${HEIGHT}）`,
  );
  if (bad.length > 0) {
    console.log('');
    for (const b of bad) console.log(`   ✖ ${b.path}  要滑 ${b.over}px`);
  }
  if (unmeasured.length > 0) {
    console.log('');
    console.log(`⚠ ${unmeasured.length} 个页面没测到真实内容：${unmeasured.map((u) => u.path).join(' ')}`);
  }
  cleanup();
  process.exit(bad.length > 0 ? 1 : unmeasured.length > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error('✖ 探针失败：', e?.message ?? e);
  process.exit(1);
});
