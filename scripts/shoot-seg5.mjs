// scripts/shoot-seg5.mjs —— 段⑤（空目录复现）自动录制
//
// 【这一段要证明什么】
// 评委没有我的 API key → 空目录 clone → npm i → 一条命令 → 走完三问出报告。
// 所以必须真的在**空目录**里做，不能拿现成仓库糊弄。
//
// 【为什么终端画面也要录进来】
// 这段的说服力全在"终端里真的在敲 git clone / npm i / npm run demo"。
// 但 OBS 采集的是 Chrome 窗口（段②③ 的配置），终端是另一个窗口 —— 所以这一段改成
// **显示器采集**，把整个屏幕（含终端 + 浏览器）一起录进去。
// 代价：录制期间不能有别的窗口弹到前台。脚本会把 Chrome 拉大但不遮挡终端的方式排布。
//
// 【时间预算】npm i 在这台机器上约 60–120s（有缓存时更快），demo 起服务约 20s。
// 成片里这段只要 60s，所以素材会明显长于成片 —— 后期按"命令输入 → 快进 → 报告"剪。
//
// 用法：
//   node scripts/shoot-seg5.mjs            # 完整录制
//   node scripts/shoot-seg5.mjs --keep     # 不删临时目录（排查用）
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const KEEP = has('--keep');
// ── 仓库地址 ────────────────────────────────────────────────────────────
// 【为什么是 SSH 不是 https】本机访问 GitHub 的 https 会被重置：
//   RPC failed; curl 56 Recv failure: Connection was reset
//   curl 28 Failed to connect to github.com port 443 after 21049 ms
// 实测 443 端口本身 TCP 可通（Test-NetConnection 为 True），是 TLS/传输层被掐。
// 同样的克隆走 SSH（22 端口）5.6 秒完成。progress.md 早就记过这条：
// 「GitHub 的 git-http（443）在本机不通，只能走 SSH」。
// 成片里观众看到的就是 `git clone git@github.com:...` —— 这更真实，不是掩饰。
const REPO_SSH = 'git@github.com:franescoothman-beep/pre-defense.git';
const REPO_HTTPS = 'https://github.com/franescoothman-beep/pre-defense';
const SSH_ENV = { ...process.env, GIT_SSH_COMMAND: 'ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=no', GIT_TERMINAL_PROMPT: '0' };
const CDP_PORT = 9340;
const OBS_PW = process.env.OBS_WS_PASSWORD ?? '4SzYEEqWT9rZhPv6';

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      setTimeout(() => this.pending.has(requestId) && (this.pending.delete(requestId), rej(new Error(type + ' 超时'))), 60000);
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

/** 把 OBS 切到显示器采集：段⑤ 要同时看到终端与浏览器 */
async function useMonitorCapture(obs) {
  const scenes = await obs.req('GetSceneList');
  const scene = scenes.currentProgramSceneName;

  // 删掉窗口采集源
  const items = await obs.req('GetSceneItemList', { sceneName: scene });
  for (const it of items.sceneItems) {
    if (/Chrome|窗口/.test(it.sourceName)) {
      await obs.req('RemoveSceneItem', { sceneName: scene, sceneItemId: it.sceneItemId }).catch(() => {});
      await obs.req('RemoveInput', { inputName: it.sourceName }).catch(() => {});
      console.log('[obs] 已移除窗口采集源');
    }
  }

  // 建显示器采集。
  //
  // 【踩过的坑】第一次录段⑤ 全程黑屏，日志里是：
  //   [duplicator-monitor-capture: '屏幕捕获'] update settings:
  //       display:  (0x0)
  // 原因是 GetInputPropertiesListPropertyItems 在**该源还不存在时**返回空，
  // 我拿到的 monitor_id 是 undefined，于是 create 时传了空串，OBS 认不出显示器。
  //
  // 正确做法：显示器 ID 必须先建一个探测器源才能列出来，或者直接用产品的已知值。
  // 这里改用 **alt_id（\\.\DISPLAY1）** —— 它对显示器重新插拔、驱动更新都稳定，
  // 不像那个长设备路径会变。396 是 OBS 里 monitor_capture 接受的坐标式 identifier，
  // 但最稳的是同时给 monitor_id 与 alt_id 两套。
  const ALT_ID = '\\\\.\\DISPLAY1';
  const MONITOR_ID =
    '\\\\?\\DISPLAY#BOE0D5E#5&7fabc57&0&UID256#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}';

  await obs.req('CreateInput', {
    sceneName: scene,
    inputName: '屏幕捕获',
    inputKind: 'monitor_capture',
    inputSettings: {
      // 这一组就是段② 里"屏幕捕获"跑通过的那一份设置（日志证实 display: NE160QDM-NYL 2560x1600）
      monitor_id: MONITOR_ID,
      capture_cursor: true,
      method: 0,
      force_sdr: false,
    },
    sceneItemEnabled: true,
  }).then(() => console.log('[obs] 已创建显示器采集源（固定 monitor_id）'))
    .catch((e) => console.log('[obs] CreateInput 失败：', e.message));

  // 建完再读回确认它真的认到了显示器
  await sleep(800);
  const back = await obs.req('GetInputSettings', { inputName: '屏幕捕获' }).catch(() => null);
  console.log('[obs] 采集源实际设置：', JSON.stringify(back?.inputSettings));
  void ALT_ID;

  const items2 = await obs.req('GetSceneItemList', { sceneName: scene });
  for (const it of items2.sceneItems) {
    await obs.req('SetSceneItemTransform', {
      sceneName: scene, sceneItemId: it.sceneItemId,
      sceneItemTransform: {
        boundsWidth: 2560, boundsHeight: 1600,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        alignment: 5, positionX: 0, positionY: 0,
      },
    }).catch(() => {});
  }
  await obs.req('SaveSceneCollection').catch(() => {});
  console.log('[obs] 场景已切到显示器采集');
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seg5-'));
  const cloneDir = path.join(workRoot, 'pre-defense');
  console.log(`[seg5] 空目录：${cloneDir}`);

  const obs = new Obs();
  await obs.connect();
  const rec = await obs.req('GetRecordStatus');
  if (rec.outputActive) throw new Error('OBS 已在录制中');

  const timeline = [];
  const mark = (l) => { timeline.push({ l, t: Date.now() }); console.log(`  · ${l}`); };
  const facts = {};
  let t0 = Date.now();
  let outPath = null;

  try {
    await useMonitorCapture(obs);
    await sleep(1500);

    await obs.req('StartRecord');
    console.log('[obs] 录制已启动');
    await sleep(1800);

    mark('开场：空目录');

    // 1) clone
    //
    // 【重试策略按"传输方式"排，而不是按参数排】
    // 第 1 次录段⑤ 撞上 `curl 56 Recv failure`，第 2 次三次 https 尝试全废
    // （最后连 443 都 21 秒超时）。所以这里前两次走 SSH（本机实测 5.6s 成功），
    // 只有 SSH 也失败才退回 https —— 反过来排会让整段录制耗在等超时上。
    console.log('[git] clone 中…');
    let cloneOk = false;
    let lastErr = '';
    const attempts = [
      ['ssh', REPO_SSH, ['--depth', '1'], SSH_ENV],
      ['ssh(全量)', REPO_SSH, [], SSH_ENV],
      ['https', REPO_HTTPS, ['--depth', '1'], { ...process.env, GIT_TERMINAL_PROMPT: '0' }],
    ];
    for (let a = 0; a < attempts.length && !cloneOk; a++) {
      const [kind, repo, extra, env] = attempts[a];
      const tClone = Date.now();
      try {
        execFileSync('git', ['clone', ...extra, repo, cloneDir], { stdio: 'pipe', env });
        facts.cloneSec = ((Date.now() - tClone) / 1000).toFixed(1);
        facts.cloneVia = kind;
        cloneOk = true;
        console.log(`[git] clone 完成（${kind}）${facts.cloneSec}s`);
      } catch (e) {
        lastErr = String(e.stderr ?? e.message).slice(-260);
        console.log(`[git] ${kind} 失败：${lastErr.split('\n').filter(Boolean).slice(-2).join(' / ')}`);
        try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
        if (a < attempts.length - 1) await sleep(3000);
      }
    }
    if (!cloneOk) throw new Error('clone 全部失败（网络问题）：' + lastErr);
    mark(`clone 完成（${facts.cloneSec}s · ${facts.cloneVia}）`);
    await sleep(2000);

    // 2) npm i（这段最久，成片里会加速）
    console.log('[npm] 安装依赖中（可能 1–2 分钟）…');
    const tNpm = Date.now();
    // 【必须不带 --omit=optional】11-02 实测那会让 Next 运行期联网下 swc，断网评委必挂
    execFileSync('npm', ['i', '--no-audit', '--no-fund'], {
      cwd: cloneDir,
      stdio: 'pipe',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_cache: path.join(workRoot, '.npm-cache') },
    });
    facts.npmSec = ((Date.now() - tNpm) / 1000).toFixed(1);
    console.log(`[npm] 完成 ${facts.npmSec}s`);
    mark(`npm i 完成（${facts.npmSec}s）`);
    await sleep(1500);

    // 3) 配环境模板
    const envLocal = path.join(cloneDir, '.env.local');
    fs.copyFileSync(path.join(cloneDir, '.env.example'), envLocal);
    console.log('[env] 已从 .env.example 生成 .env.local');
    mark('拷贝 .env.example → .env.local');
    await sleep(1500);

    // 4) npm run demo（后台，等健康检查）
    console.log('[demo] 启动中…');
    const logPath = path.join(workRoot, 'demo.log');
    const demoProc = spawn('npm', ['run', 'demo'], {
      cwd: cloneDir,
      stdio: 'ignore',
      detached: false,
      shell: process.platform === 'win32',
      env: { ...process.env, PORT: '3211', MOCK_LLM: '1' },
    });
    facts.demoPid = demoProc.pid;

    // 等 /api/health
    let health = null;
    const tDemo = Date.now();
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch('http://127.0.0.1:3211/api/health');
        if (r.ok) { health = await r.json(); break; }
      } catch {}
      await sleep(1000);
    }
    if (!health?.ok) throw new Error('demo 服务在 120s 内没起来');
    facts.demoSec = ((Date.now() - tDemo) / 1000).toFixed(1);
    console.log(`[demo] 就绪 ${facts.demoSec}s · mode=${health.mode}`);
    mark(`npm run demo 就绪（${facts.demoSec}s）`);

    // 5) 浏览器打开并走完三问
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'seg5p-'));
    const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    const child = spawn(fs.existsSync(chrome) ? chrome : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1707,1067', '--window-position=0,0',
      '--force-device-scale-factor=1.875',
      '--no-first-run', '--no-default-browser-check',
      'http://127.0.0.1:3211/',
    ], { stdio: 'ignore' });

    let wsUrl = null;
    for (let i = 0; i < 90; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const p = l.find((t) => t.type === 'page');
        if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(200);
    }
    if (!wsUrl) throw new Error('CDP 未就绪');

    const sock = new WebSocket(wsUrl);
    await new Promise((r) => sock.addEventListener('open', r, { once: true }));
    let cid = 0;
    const pend = new Map();
    sock.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); }
    });
    const send = (method, params = {}) => new Promise((r, j) => {
      const i = ++cid; pend.set(i, { r, j }); sock.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

    await sleep(3500);
    mark('浏览器打开首页（MOCK 角标）');
    await sleep(1200);

    // 直接走 API 建会话（浏览器只用来展示）
    const demo = await (await fetch('http://127.0.0.1:3211/api/demo')).json();
    const s = await (await fetch('http://127.0.0.1:3211/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: demo.docId, mode: 'quick' }),
    })).json();
    if (!s.ok) throw new Error('建会话失败：' + JSON.stringify(s).slice(0, 200));
    facts.judges = s.personas.map((p) => p.name).join('/');
    console.log(`[demo-session] ${s.sessionId.slice(0, 8)} · ${facts.judges}`);

    await send('Page.navigate', { url: `http://127.0.0.1:3211/session/${s.sessionId}` });
    await sleep(4000);
    mark('答辩现场（三问）');

    // 三问三答（按页面真实按钮）
    //
    // 【循环上限必须是 6 而不是 5】quick 档最坏是 3 主问 + 2 追问 = 5 次作答。
    // 第一次录段⑤ 写死 5 次，结果第 4 条追问的 ansLen=0（还没把字打进去就提交了），
    // 第 3 位评委的问题因此没机会出现，报告的 depth 维度变成 null。
    // 现在多给一轮，靠"不再可作答就 break"自然收口；并且提交前校验字数。
    const ANSWER = '这一问我们确实考虑了。800 条评测集在多轮调优里反复用过，96.8% 正是调在这同一批上算的，存在过拟合，会切出独立留出集。';
    for (let i = 0; i < 6; i++) {
      const ok = await (async () => {
        for (let k = 0; k < 80; k++) {
          const st = await ev(`(() => {
            const ta = document.querySelector('textarea.answer-input');
            const body = document.body ? document.body.innerText : '';
            return JSON.stringify({
              has: !!ta, dis: ta ? ta.disabled : true,
              ended: /已问完|可以出报告|报告就绪|本场已结束/.test(body),
            });
          })()`);
          const o = JSON.parse(st);
          if (o.ended) return false;
          if (o.has && !o.dis) return true;
          await sleep(400);
        }
        return false;
      })();
      if (!ok) { console.log(`[demo] 第 ${i + 1} 轮已不可作答，收口`); break; }

      for (const ch of ANSWER) { await send('Input.insertText', { text: ch }).catch(() => {}); await sleep(40); }
      await sleep(500);

      // 【必须校验真的写进去了】空答案会让这一问没判分，下一位评委就问不出来
      const len = await ev(`(document.querySelector('textarea.answer-input')?.value ?? '').length`);
      if (!len || len < 20) { console.log(`[demo] 第 ${i + 1} 轮回答框仅 ${len} 字，跳过提交`); break; }

      await ev(`(() => { const b = document.querySelector('button.answer-submit'); if (b && !b.disabled) b.click(); })()`);
      await sleep(2800);
      mark(`第 ${i + 1} 次作答提交（${len} 字）`);
    }

    const end = await (await fetch(`http://127.0.0.1:3211/api/sessions/${s.sessionId}/end`, { method: 'POST' })).json();
    facts.perf = (end.performance ?? []).map((p) => `${p.dimension}:${p.score ?? '—'}`).join(' ');
    facts.risk = (end.material_risk ?? []).map((m) => `${m.dimension}:${m.risk_score ?? '—'}`).join(' ');
    facts.high = (end.high_risk ?? []).length;
    console.log(`[demo-report] perf ${facts.perf} · risk ${facts.risk} · high ${facts.high}`);

    await send('Page.navigate', { url: `http://127.0.0.1:3211/report/${s.sessionId}` });
    await sleep(5000);
    mark('报告页（零 key 走完）');
    await sleep(2500);

    try { sock.close(); } catch {}
    try { child.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    try { demoProc.kill(); } catch {}
  } finally {
    await sleep(1200);
    const res = await obs.req('StopRecord').catch((e) => ({ outputPath: null, err: e.message }));
    outPath = res.outputPath ?? null;
    console.log('[obs] 录制已停止 →', outPath ?? res.err);
    obs.close();

    const total = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n总时长 ${total}s`);

    const recDir = path.join('docs', 'recordings');
    fs.mkdirSync(recDir, { recursive: true });
    const md = [
      `# 段⑤ 自动录制 ${new Date().toLocaleString('zh-CN')}`,
      '',
      `- 录制文件：\`${outPath ?? '(未录)'}\``,
      `- 采集方式：**显示器采集**（要同时看到终端与浏览器）`,
      `- 仓库：${REPO_HTTPS}（实际用 ${facts.cloneVia ?? '?'} 克隆）`,
      `- clone：${facts.cloneSec ?? '?'}s · npm i：${facts.npmSec ?? '?'}s · demo 就绪：${facts.demoSec ?? '?'}s`,
      `- 评委：${facts.judges ?? '?'}`,
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
    const mdPath = path.join(recDir, `seg5-${stamp}.md`);
    fs.writeFileSync(mdPath, md, 'utf8');
    console.log('时间线 →', mdPath);

    if (!KEEP) {
      try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch {}
      console.log('[seg5] 已清理临时目录');
    } else {
      console.log('[seg5] 保留临时目录：', workRoot);
    }
  }
}

main().then(() => setTimeout(() => process.exit(0), 300))
  .catch((e) => { console.error('✖ ' + e.message); setTimeout(() => process.exit(1), 300); });
