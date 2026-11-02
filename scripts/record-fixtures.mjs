// scripts/record-fixtures.mjs —— 用**真实 key** 跑一场完整 quick 会话，把模型真实产出落成 5 个 fixture
//
// 【为什么必须用真实模型生成，绝不手写】
// 手写 fixture 会让 mock 静默通过一个"真实模式会失败"的结构。
// 阶段 2 就踩过这个雷：手写的 quote 少一个字，机检判 verified=0，
// 而演示时没人逐字核对，命中率会静默掉一截。
//
// 【为什么改成"读 capture 日志"，而不是脚本里自己拼 response】
// 旧版脚本有一个真 bug：第 2、3 位评委的 opening.question 是脚本拼的
// `「${p.name}：这条质疑点你怎么答？」` —— 占位串，不是模型说的话。
// mock 回放时这三位评委里有两位在说同一句废话，演示现场一眼假。
// 根源是"脚本想复现模型输出，但手上只有路由加工后的字段"。
// 现在的做法：lib/llm.ts 在真实调用成功后把 `{phase, system, user, response}`
// 追加进 logs/llm-capture.jsonl（只在 LLM_CAPTURE=1 时），录制脚本读它。
// 这样拿到的就是**真实的、已经过完 zod 的对象**，不需要在脚本里重写重试/extractJson/校验三段逻辑。
//
// 【为什么一场会话录全部 5 个 phase】
// 阶段 3 只有 personas + 首问，所以旧版 question 是"多场各取首问"，
// 而 mock 回放是**序号驱动**的：一场会话里第 2、3 问必须来自同一场。
// 现在有 /answer 与 /next，可以真的把 quick 三问走完，顺带把 evaluate 与 report 也录下来 ——
// 这两个 phase 之前完全没有 fixture，导致零 key 闭环走不到"判分之后"，报告永远出不来。
//
// 用法（须 .env.local 里 MOCK_LLM=0 + 真实 key，服务带 LLM_CAPTURE=1 起）：
//   $env:LLM_CAPTURE="1"; node node_modules/next/dist/bin/next dev -p 3111
//   node scripts/record-fixtures.mjs [baseUrl]
//
// 产物（整体替换，不追加 —— mock 是序号驱动的，追加会把序号推歪）：
//   fixtures/llm/{claims 不动, personas, question, evaluate, report}.json

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3111';
const DOC_ID = '86322517-36ae-46cc-8dfa-300150d283dd';
const FIX_DIR = path.join(process.cwd(), 'fixtures', 'llm');
const CAPTURE = path.join(process.cwd(), 'logs', 'llm-capture.jsonl');

/** 录制用的三套答案：内容具体但留有缺口，能拿到分，也可能触发追问 */
const ANSWERS = [
  '我们按学校规模做了分层随机抽样，三所学校分别覆盖大中小规模。但分母取的是这三所学校一学期的记录总数，没有给出抽样比例。',
  '这个提升幅度是同一批学生在参与前后各一次问卷的差值，没有设对照组，所以严格说这是相关而不是因果。',
  '做了消融实验，去掉任何一路输入都会掉点，具体数值在实验章节的表格里。',
];
const FOLLOWUP_ANSWERS = [
  '补充一下：分母是这三所学校该年级全部学生的记录数，抽样比例是各校各年级按 30% 抽。',
  '再补一句：对照组是同一批学生上一年度的同期数据。',
];

function fail(msg) {
  console.error('\n✖ 录制失败：' + msg);
  process.exit(1);
}

async function get(p) {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function post(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** 手写 SSE 解析：拿问题全文 + meta + done。与 scripts/probe-stage4.mjs 同款。 */
async function streamOnce(sessionId) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  if (!res.ok || !res.body) return { error: { code: `HTTP_${res.status}` }, ms: Date.now() - t0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  let cur = { name: 'message', data: '' };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line === '') {
        if (cur.data) events.push({ name: cur.name, payload: JSON.parse(cur.data) });
        cur = { name: 'message', data: '' };
        continue;
      }
      if (line.startsWith(': ')) continue;
      if (line.startsWith('event: ')) cur.name = line.slice(7).trim();
      else if (line.startsWith('data: ')) cur.data += line.slice(6);
    }
  }
  if (cur.data) events.push({ name: cur.name, payload: JSON.parse(cur.data) });
  return {
    events,
    text: events.filter((e) => e.name === 'token').map((e) => e.payload?.t ?? '').join(''),
    meta: events.find((e) => e.name === 'meta')?.payload,
    done: events.find((e) => e.name === 'done')?.payload,
    error: events.find((e) => e.name === 'error')?.payload,
    ms: Date.now() - t0,
  };
}

function writeFixture(phase, entries, notes) {
  const file = path.join(FIX_DIR, `${phase}.json`);
  fs.writeFileSync(file, JSON.stringify({ notes, seq: entries }, null, 2) + '\n', 'utf8');
  console.log(`  ✔ ${phase}.json 写入 ${entries.length} 条`);
}

console.log('═'.repeat(66));
console.log('录制 fixture（真实 key → 真实端点 → capture 日志 → 落盘）');
console.log('═'.repeat(66));

// ---------- 前置 ----------
const health = await get('/api/health').catch(() => ({ json: null }));
if (!health.json?.ok) fail(`连不上 ${BASE}。先起服务：node node_modules/next/dist/bin/next start -p 3111`);
if (health.json.mock) fail('当前服务是 MOCK_LLM=1。录制必须关 mock 并用真实 key（改 .env.local 后重启）。');

// capture 日志清空：否则上一轮的条目会混进来，序号全歪
fs.mkdirSync(path.dirname(CAPTURE), { recursive: true });
fs.rmSync(CAPTURE, { force: true });
console.log('真实模式: 已确认 · capture 日志已清空');

// ---------- 1) 建会话 ----------
const created = (await post('/api/sessions', { docId: DOC_ID, mode: 'quick' })).json;
if (!created?.ok) fail(`建会话失败（${created?.code}）：${created?.message}`);
const sessionId = created.sessionId;
console.log(`会话    : ${sessionId.slice(0, 8)}… · ${created.judges} 位评委`);
console.log('评委    :', created.personas.map((p) => `${p.name}(${p.role}/${p.dimension})`).join(' / '));
console.log('首问    :', created.question.question);

// ---------- 2) 走完 quick 三问 ----------
const mainTurns = []; // 记录第 i 个主问的真实问题与锚点，供 personas 兜底
console.log('\n[1/3] 跑完 quick 三问');
for (let r = 1; r <= 3; r++) {
  const s = await streamOnce(sessionId);
  if (s.error) fail(`第 ${r} 问的 SSE 报错：${JSON.stringify(s.error)}`);
  if (!s.done?.turnId) fail(`第 ${r} 问没有拿到 turnId（done=${JSON.stringify(s.done)}）`);
  mainTurns.push({ question: s.text, claimId: s.done?.meta?.claimId ?? s.meta?.claimId, meta: s.meta });
  console.log(`  ${r}. ${s.text}`);
  console.log(`     turnId=${String(s.done.turnId).slice(0, 8)}… · 锚点块 ${s.meta?.blockIdx} · ${s.ms}ms`);

  let resp = (await post(`/api/sessions/${sessionId}/answer`, { turnId: s.done.turnId, answer: ANSWERS[(r - 1) % 3] })).json;
  if (!resp?.ok) fail(`第 ${r} 问作答失败：${resp?.code} ${resp?.message}`);
  console.log(`     判分 ${resp.evaluation?.score}/5 · decision=${resp.decision} · ${resp.endReason ?? ''}`);

  // 追问最多两层（HARD_LIMITS.perPersonaFollowups = 2）
  for (let f = 0; f < 2 && resp?.decision === 'followup' && resp.followup; f++) {
    console.log(`     追问：${resp.followup.question}`);
    resp = (
      await post(`/api/sessions/${sessionId}/answer`, {
        turnId: resp.followup.turnId,
        answer: FOLLOWUP_ANSWERS[f % 2],
      })
    ).json;
    if (!resp?.ok) fail(`追问作答失败：${resp?.code} ${resp?.message}`);
    console.log(`     追问判分 ${resp.evaluation?.score}/5 · decision=${resp.decision}`);
  }

  if (resp.decision === 'end' || resp.nextAction === 'report') {
    console.log(`     → 已收口（${resp.endReason ?? '主问问完'}）`);
    break;
  }
  const nx = (await post(`/api/sessions/${sessionId}/next`)).json;
  console.log(`     /next → ${nx?.nextAction} ${nx?.message ?? ''}`);
  if (nx?.nextAction === 'report') break;
}

// ---------- 3) 出报告（report phase） ----------
console.log('\n[2/3] 出报告');
const end = (await post(`/api/sessions/${sessionId}/end`)).json;
if (!end?.ok) fail(`/end 失败：${end?.code} ${end?.message}`);
console.log(`  报告 ${String(end.reportId).slice(0, 8)}… · degraded=${end.degraded}`);
console.log(`  材料风险 ${end.material_risk?.length ?? 0} 维 · 临场表现 ${end.performance?.length ?? 0} 维 · 高风险 ${end.high_risk?.length ?? 0} 条`);

// ---------- 4) 从 capture 日志按 phase 落盘 ----------
console.log('\n[3/3] 从 capture 日志落盘');
if (!fs.existsSync(CAPTURE)) {
  fail(
    `没有 ${CAPTURE}。服务启动时必须带 LLM_CAPTURE=1，否则 lib/llm.ts 的 capture 钩子不会写日志。\n` +
      '  正确起法：$env:MOCK_LLM="0"; $env:LLM_CAPTURE="1"; node node_modules/next/dist/bin/next dev -p 3111',
  );
}
const captured = fs
  .readFileSync(CAPTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const byPhase = new Map();
for (const c of captured) {
  if (!byPhase.has(c.phase)) byPhase.set(c.phase, []);
  byPhase.get(c.phase).push(c);
}
console.log('  capture 统计：', [...byPhase.entries()].map(([p, v]) => `${p}×${v.length}`).join(' · '));

for (const p of ['claims', 'personas', 'question', 'evaluate', 'report']) {
  if (p === 'claims') continue; // claims 是上传后抽取，不在本场会话里，保持原样
  if (!byPhase.get(p)?.length) fail(`capture 日志里没有「${p}」这一 phase，本场没跑完整。`);
}

// ---- personas：模型原始输出，但要保证每位评委的 opening 落在**自己席位的候选清单**里 ----
//
// 服务端有锚点归属校验：第 i 位评委的 opening 只能用第 i 席的候选 claim，
// 校验不过的评委会被丢掉（表现为 judges:1 而 seated:3）。
// 模型不一定守规矩，所以这里先按"席位候选集合"检查一遍：
//   · 模型自己给的 claim_id 合法 → 原样保留（这是最好的情况）
//   · 不合法 → 换成该席位里 risk 最高的那条，问题文本用**系统真实问过的那一句**（mainTurns[i]）
// 换锚点不换问题：问题是真的，锚点必须是本席位内的，两者都不能编。
const db = new DatabaseSync('data/app.db', { readOnly: true });
const claimRows = db.prepare('select id, dimension, type, risk from claims where doc_id = ?').all(DOC_ID);
const claimById = new Map(claimRows.map((c) => [String(c.id), c]));
const seats = created.coverage?.seated ?? [];
const seatIds = seats.map(
  (s) => new Set(claimRows.filter((c) => c.dimension === s.dimension && c.type === s.type).map((c) => String(c.id))),
);
const topOfSeat = (i) => {
  const ids = seatIds[i];
  const row = claimRows.filter((c) => ids?.has(String(c.id))).sort((a, b) => Number(b.risk) - Number(a.risk))[0];
  return row ? String(row.id) : null;
};

const rawPersonas = byPhase.get('personas')[0].response;
const personasResponse = {
  personas: rawPersonas.personas.slice(0, Math.max(1, created.personas.length)).map((p, i) => {
    const allowed = seatIds[i] ?? new Set();
    const kept = (p.opening ?? []).filter((o) => allowed.has(String(o.claim_id)));
    const opening =
      kept.length > 0
        ? kept
        : [
            {
              claim_id: topOfSeat(i) ?? mainTurns[i]?.claimId,
              // 系统真实问过的那一句（第 i 个主问就是第 i 位评委问的）
              question: mainTurns[i]?.question ?? p.opening?.[0]?.question,
            },
          ];
    console.log(
      `    ${i + 1}. ${p.name}（席位 ${seats[i]?.dimension ?? '?'}/${seats[i]?.type ?? '?'}）` +
        (kept.length > 0 ? ' 模型锚点合法，原样保留' : ' 模型锚点越席，已换成本席位最高风险条目'),
    );
    return { name: p.name, role: p.role, focus: p.focus, tone: p.tone, opening };
  }),
};
writeFixture(
  'personas',
  [{ inputHash: `doc:${DOC_ID}`, response: personasResponse }],
  'MOCK 回放：三位评委人设 + 首问。由真实 key 跑 POST /api/sessions 后从 logs/llm-capture.jsonl 落盘，' +
    '不是手拼的占位串。每位评委的 opening 均落在**自己席位的候选清单**内（服务端有锚点归属校验）。',
);

// ---- question：一场会话里的三问，序号驱动 ----
// 旧版是"多场各取首问"（阶段 3 没有 /answer），mock 回放时第 2、3 问会串场。
const questionRaw = byPhase.get('question');
writeFixture(
  'question',
  questionRaw.map((c, i) => ({ inputHash: `q${i + 1}`, response: c.response })),
  `MOCK 回放：评委提问（${questionRaw.length} 条，**同一场 quick 会话里的连问**，序号驱动、不按内容路由 C15）。` +
    '由真实 key 跑 SSE 后从 logs/llm-capture.jsonl 落盘。',
);

// ---- evaluate：每次作答的判分（含追问），序号驱动 ----
const evaluateRaw = byPhase.get('evaluate');
writeFixture(
  'evaluate',
  evaluateRaw.map((c, i) => ({ inputHash: `a${i + 1}`, response: c.response })),
  `MOCK 回放：作答判分（score/gaps/locators/followup），共 ${evaluateRaw.length} 条，按作答顺序回放。` +
    '跟进问的判分也在其中 —— mock 是序号驱动，不看答案内容。',
);

// ---- report：整场报告（宽松版：locator 允许是字符串） ----
const reportRaw = byPhase.get('report');
writeFixture(
  'report',
  reportRaw.map((c, i) => ({ inputHash: `report${i + 1}`, response: c.response })),
  'MOCK 回放：整场报告（material_risk 评语 / performance 打分 / high_risk / advice）。' +
    '注意 material_risk 的 risk_score 一律由服务端从 claims 聚合，模型的 locator 只用来溯源，' +
    '报告允许 locator 是纯字符串（会被标成"位置未标注、verified=0"，并计入引用命中率分母）。',
);

// ---------- 自检 ----------
console.log('\n' + '═'.repeat(66));
console.log('落盘结果');
console.log('═'.repeat(66));
for (const f of ['claims.json', 'personas.json', 'question.json', 'evaluate.json', 'report.json']) {
  const p = path.join(FIX_DIR, f);
  const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { seq: [] };
  console.log(`  ${f.padEnd(15)} ${(j.seq ?? []).length} 条`);
}
console.log(`\n录制会话：${sessionId}`);
console.log('⚠ lib/mock.ts 有进程级缓存：写完后必须重启服务，mock 才会读到新 fixture。');
console.log('⚠ 改完 fixture 必须跑 npm run test:fixtures，确认全部过当前 schema。');
