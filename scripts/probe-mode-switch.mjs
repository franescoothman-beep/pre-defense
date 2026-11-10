// scripts/probe-mode-switch.mjs —— 模式切换按钮的真人交互探针
//
// 【为什么单独写这个，而不是塞进 dry-run-shoot】
// dry-run-shoot 是"录制时间线"，跑一遍 ~70s 且会拍 23 张图；它验证的是
// 整条演示动线，不是这个新开关。切模式按钮只需 10 秒就能验收，且必须验证
// **真的点了、真的发请求、真的整页刷新、刷新后档位来自服务端** ——
// 这四点用静态 HTML 断言测不出来。
//
// 用法：先起服务，再 `node scripts/probe-mode-switch.mjs --base http://127.0.0.1:3111`
// 它会自己把模式复位成 mock（不污染演示环境）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CDP_PORT = 9333;
const W = 1280;
const H = 900;
const argBase = process.argv.indexOf('--base');
const BASE = argBase > -1 ? process.argv[argBase + 1] : 'http://127.0.0.1:3111';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? ' · ' + detail : ''}`);
}

function launch() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge/Chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'modeswitch-'));
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      '--headless=new',
      `--window-size=${W},${H}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  return { child, profile };
}

async function wsEndpoint() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const ts = await r.json();
      const page = ts.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('CDP 未就绪');
}

function cdp(ws) {
  let id = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) for (const f of listeners) f(m);
  });
  return {
    send(method, params = {}) {
      const mid = id++;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid);
            rej(new Error(method + ' 超时'));
          }
        }, 25_000);
      });
    },
    on(f) {
      listeners.push(f);
    },
  };
}

const ev = async (c, expression) => {
  const { result, exceptionDetails } = await c.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' :: ' + expression.slice(0, 80));
  return result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 点击某个档位并**等真正的整页导航完成**。
 *
 * 【为什么必须等 load 事件，不能只等 class 变化】
 * React 在 fetch 返回后先 setMode(next)（DOM 的 on class 立刻翻），
 * 紧接着才 window.location.reload()。若只盯着 class，会在 reload 还没完成时
 * 就断言/继续点击 —— 此时按钮仍处于 disabled={busy}，第二次点击会被丢掉，
 * 表现为"切不回去"。这是探针的时序 bug，不是产品 bug；等 loadEventFired 即可。
 */
async function clickAndAwaitReload(c, keyword) {
  const loaded = new Promise((res) => {
    const f = (m) => {
      if (m.method === 'Page.loadEventFired') res(true);
    };
    c.on(f);
    setTimeout(() => res(false), 20_000);
  });
  const clicked = await ev(
    c,
    `(() => {
       const b = [...document.querySelectorAll('.mode-switch .seg')].find(x => x.innerText.includes(${JSON.stringify(keyword)}));
       if (!b) return 'no-btn';
       if (b.disabled) return 'disabled';
       b.click();
       return 'clicked';
     })()`,
  );
  const navigated = clicked === 'clicked' ? await loaded : false;
  // 导航后再等一拍，让 hydration 完成
  if (navigated) await sleep(400);
  return { clicked, navigated };
}

async function goto(c, url) {
  await c.send('Page.navigate', { url });
  // 等 document.readyState === 'complete'
  for (let i = 0; i < 100; i++) {
    try {
      if ((await ev(c, `document.readyState`)) === 'complete') return;
    } catch {
      /* 导航中 */
    }
    await sleep(100);
  }
  throw new Error('页面未加载完成: ' + url);
}

async function main() {
  console.log(`模式切换探针 · ${BASE}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  ok('health 可读', health.ok === true, `mode=${health.mode} mock=${health.mock}`);

  // 从干净态开始
  await fetch(`${BASE}/api/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'mock' }),
  });

  const { child, profile } = launch();
  try {
    const ws = new WebSocket(await wsEndpoint());
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const c = cdp(ws);
    await c.send('Page.enable');
    await c.send('Runtime.enable');

    await goto(c, `${BASE}/`);

    // ── 1) 初始态：mock 档位被高亮 ──────────────────────────────────
    const segs = () =>
      ev(
        c,
        `JSON.stringify([...document.querySelectorAll('.mode-switch .seg')].map(b => ({t:(b.innerText||'').trim(), on:b.classList.contains('on'), pressed:b.getAttribute('aria-pressed')})))`,
      ).then((s) => JSON.parse(s));

    let s = await segs();
    ok('控件渲染两个档位', s.length === 2, s.map((x) => x.t).join(' | '));
    ok('初始 mock 档高亮', s[0]?.on === true && s[0]?.pressed === 'true');
    ok('MOCK 角标可见', (await ev(c, `!!document.querySelector('.mock-banner')`)) === true);

    // ── 2) 真人点击「真实 · 实时模型」────────────────────────────────
    const r1 = await clickAndAwaitReload(c, '真实');
    ok('点击真实档位', r1.clicked === 'clicked', r1.clicked);
    ok('点击触发整页刷新', r1.navigated === true);

    const after = await segs().catch(() => []);
    ok('刷新后真实档高亮', after[1]?.on === true, after.map((x) => `${x.t}:${x.on}`).join(' | '));

    // ── 3) 刷新后状态来自服务端（不是前端自己记的）───────────────────
    const h2 = await fetch(`${BASE}/api/health`).then((r) => r.json());
    ok('服务端 mode 已变为 real', h2.mode === 'real', `mode=${h2.mode}`);
    ok('real 模式下角标消失（不谎称回放）', (await ev(c, `!document.querySelector('.mock-banner')`)) === true);

    // ── 4) 切回 mock，复位环境 ─────────────────────────────────────
    const r2 = await clickAndAwaitReload(c, '演示');
    ok('点击演示档位', r2.clicked === 'clicked', r2.clicked);
    ok('切回也触发整页刷新', r2.navigated === true);

    const back = await segs().catch(() => []);
    ok('切回 mock 档高亮', back[0]?.on === true, back.map((x) => `${x.t}:${x.on}`).join(' | '));
    const h3 = await fetch(`${BASE}/api/health`).then((r) => r.json());
    ok('服务端 mode 已复位 mock', h3.mode === 'mock', `mode=${h3.mode}`);
    ok('mock 角标恢复', (await ev(c, `!!document.querySelector('.mock-banner')`)) === true);

    // ── 5) 窄屏不溢出 ──────────────────────────────────────────────
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: 400,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await goto(c, `${BASE}/`);
    await sleep(400);
    const overflow = await ev(c, `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`);
    ok('400px 窄屏无横向溢出', overflow === false);
    await c.send('Emulation.clearDeviceMetricsOverride');

    ws.close();
  } finally {
    child.kill();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('探针异常：', e.message);
  process.exitCode = 1;
});
