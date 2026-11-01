// scripts/probe-stage5.mjs —— 阶段 5 端到端探针（真实 key 必跑，非交付脚本）
//
// 验证阶段 5 DoD 的四条：
//   1. 质询风险看板：3 行 × 4 格，格子能由 claims 复算，空格是 null 不是 0
//   2. revise：出 risk 分差 + claim 增删；drill：只出 perf 分差，**绝不出现 −0**
//   3. 两种总分（overallRisk / overallPerf）与各自格子加权一致
//   4. 报告页能真的打开（客户端壳 + API 字段齐全）
//
// 【为什么这条探针必须跑真实 key】看板与 delta 的数字都来自「模型抽的 claims + 服务端聚合」。
// MOCK 回放里 claims 是录制好的，聚合永远一致 —— 那样测出来的"一致"是假的。
//
// 用法：node scripts/probe-stage5.mjs

import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:3111';

const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  ${cond ? '✔' : '✖'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

/** 读 SSE 到结束 */
async function streamOnce(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  let cur = null;
  let data = [];
  const flush = () => {
    if (!cur) return;
    let payload = null;
    try { payload = data.length ? JSON.parse(data.join('\n')) : null; } catch { /* ignore */ }
    events.push({ name: cur, payload });
    cur = null; data = [];
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) { cur = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) { data.push(line.slice(5).trimStart()); continue; }
    }
  }
  flush();
  const text = events.filter((e) => e.name === 'token').map((e) => e.payload?.t ?? '').join('');
  return {
    text,
    meta: events.find((e) => e.name === 'meta')?.payload ?? null,
    done: events.find((e) => e.name === 'done')?.payload ?? null,
    error: events.find((e) => e.name === 'error')?.payload ?? null,
  };
}

/** 一个答案池：有具体内容但留缺口，判分才有区分度 */
const ANSWERS = [
  '我们按学校规模做了分层随机抽样，三所学校分别覆盖大中小规模；但分母取的是这三所学校一学期的记录总数，没有给出抽样比例。',
  '这个提升幅度是同一批学生参与前后各一次问卷的差值，没有设对照组，所以严格说是相关而不是因果。',
  '做了消融实验，去掉任何一路输入都会掉点，具体数值在实验章节的表格里，这里只给了结论。',
  '工程上用的是单机 SQLite，并发上限没有压测过；如果同时来一百个人可能要排队。',
];

/** 跑一整场：建会话 → 逐个主问作答（含追问）→ 出报告 */
async function runSession(label, createBody, maxTurns = 10) {
  console.log(`\n【${label}】POST /api/sessions ${JSON.stringify(createBody)}`);
  const created = await post('/api/sessions', createBody);
  if (!created.json?.ok) {
    console.error('  建会话失败：', created.status, created.text.slice(0, 400));
    return null;
  }
  const sid = created.json.sessionId;
  console.log(`  会话 ${sid.slice(0, 8)}… · ${created.json.judges} 位评委 · 上限 ${created.json.maxTurns} 轮 · ${created.json.modeLabel}`);

  let answered = 0;
  for (let i = 0; i < maxTurns; i++) {
    const s = await streamOnce(sid);
    if (s.error) {
      console.log(`  ✖ SSE error：${JSON.stringify(s.error)}`);
      break;
    }
    if (!s.done?.turnId) {
      console.log(`  · 没有新问题（state 已收口）`);
      break;
    }
    const ans = ANSWERS[answered % ANSWERS.length];
    const r = await post(`/api/sessions/${sid}/answer`, { turnId: s.done.turnId, answer: ans });
    answered += 1;
    if (!r.json?.ok) {
      console.log(`  ✖ /answer 失败：${r.status} ${r.text.slice(0, 200)}`);
      break;
    }
    const step = `  #${String(i + 1).padStart(2, '0')} ${s.meta?.persona ?? '?'}（第 ${s.meta?.qIndex ?? '?'}/${s.meta?.qTotal ?? '?'} 问）判分 ${r.json.evaluation?.score ?? '降级'} · decision=${r.json.decision}${r.json.followup ? ' +追问' : ''}`;
    console.log(step);
    if (r.json.decision === 'followup' && r.json.followup) {
      const fa = await post(`/api/sessions/${sid}/answer`, {
        turnId: r.json.followup.turnId,
        answer: '补充一句：抽样比例是各校各年级按 30% 抽，对照组取的是上一年度同期数据。',
      });
      answered += 1;
      console.log(`      追问判分 ${fa.json?.evaluation?.score ?? '—'} · decision=${fa.json?.decision}`);
      if (fa.json?.decision === 'end') break;
      continue;
    }
    if (r.json.decision === 'end') {
      console.log(`  收口原因：${r.json.endReason ?? '—'}`);
      break;
    }
    const nx = await post(`/api/sessions/${sid}/next`);
    if (nx.json?.nextAction === 'report') break;
  }

  const t0 = Date.now();
  const end = await post(`/api/sessions/${sid}/end`);
  console.log(`  /end ${end.status} · ${Date.now() - t0}ms · cached=${end.json?.cached} · degraded=${end.json?.degraded}`);
  return { sessionId: sid, end: end.json, answered };
}

/** 从 claims 复算某一维的 risk_score（与 lib/report.ts 的 weightOf 同口径） */
function recomputeRisk(docId) {
  const db = new DatabaseSync('data/app.db', { readOnly: true });
  const rows = db.prepare('select dimension, risk, verified, locator_kind from claims where doc_id = ?').all(docId);
  db.close();
  const out = {};
  for (const r of rows) {
    const w = r.locator_kind === 'absence' ? 0.8 : r.verified === 1 ? 1.0 : 0.5;
    (out[r.dimension] ??= { num: 0, den: 0 });
    out[r.dimension].num += w * ((r.risk - 1) / 4);
    out[r.dimension].den += w;
  }
  const risk = {};
  const absence = {};
  for (const [dim, v] of Object.entries(out)) {
    risk[dim] = Math.round((100 * v.num) / v.den);
  }
  const db2 = new DatabaseSync('data/app.db', { readOnly: true });
  for (const r of db2.prepare("select dimension, count(*) as n from claims where doc_id = ? and locator_kind = 'absence' group by dimension").all(docId)) {
    absence[r.dimension] = r.n;
  }
  db2.close();
  return { risk, absence };
}

function pickDocs() {
  const db = new DatabaseSync('data/app.db', { readOnly: true });
  const rich = db
    .prepare(
      `select d.id, d.name, (select count(*) from claims c where c.doc_id=d.id) as n
       from documents d order by n desc limit 1`,
    )
    .get();
  // 「改后的材料」：换一份已抽过质疑点的材料（真实改写需要人写文件，探针只验 delta 的接线）
  const other = db
    .prepare(
      `select d.id, d.name, (select count(*) from claims c where c.doc_id=d.id) as n
       from documents d where d.id <> ? and (select count(*) from claims c where c.doc_id=d.id) > 0
       order by n asc limit 1`,
    )
    .get(rich?.id ?? '');
  db.close();
  return { rich, other };
}

// ══════════════════════════════════════════════════════════════════════════

const HEALTH = await get('/api/health');
console.log('═'.repeat(72));
console.log('阶段 5 端到端探针（真实 key）');
console.log('═'.repeat(72));
console.log('health:', JSON.stringify(HEALTH.json));
if (HEALTH.json?.mock) {
  console.error('\n✖ 当前服务是 MOCK_LLM=1。看板与 delta 的数字必须由真实模型抽的 claims 驱动。');
  process.exit(1);
}

const { rich, other } = pickDocs();
if (!rich || !other) {
  console.error('\n✖ 库里至少需要两份「已抽过质疑点」的材料。');
  process.exit(1);
}
console.log(`材料 A：${rich.name}（${rich.id.slice(0, 8)}…，${rich.n} 条质疑点）`);
console.log(`材料 B（代替"改后的材料"）：${other.name}（${other.id.slice(0, 8)}…，${other.n} 条质疑点）`);

// ══════════ 1) quick 全流程 ══════════
const base = await runSession('1 · quick 全流程', { docId: String(rich.id), mode: 'quick' });
if (!base?.end?.ok) { console.error('✖ quick 流程失败'); process.exit(1); }
const r1 = base.end;
check('quick 出报告', r1.ok === true);
check('报告不是降级模板', r1.degraded !== true, `degraded=${r1.degraded}`);
check('report 里没有 delta（首场没有上一场可比）', r1.delta == null);

// ══════════ 2) 报告接口：看板 + 两种总分 ══════════
console.log('\n【2】GET /api/reports/:id —— 看板与两种总分');
const rep1 = await get(`/api/reports/${base.sessionId}`);
check('报告可读', rep1.json?.ok === true);
const ctx1 = rep1.json?.context ?? {};
const board = ctx1.board ?? [];
check('看板是三行', board.length === 3, `实际 ${board.length}`);
check('每行四个维度格', board.every((r) => r.cells.length === 4));
check(
  '看板类型顺序固定',
  board.map((r) => r.type).join(',') === 'method,engineering,value',
  board.map((r) => r.type).join(','),
);
check(
  '行头标出占席评委（材料有这类质疑时）',
  board.filter((r) => r.total > 0).every((r) => typeof r.judgeName === 'string' && r.judgeName.length > 0),
  board.map((r) => `${r.type}:${r.judgeName ?? 'null'}`).join(' | '),
);
check(
  '材料里没有的格子是 null 而不是 0',
  board.every((r) => r.cells.every((c) => (c.count === 0 ? c.risk_score === null : typeof c.risk_score === 'number'))),
);
check(
  '格子可点：每格都能定位到该 (维度,类型)',
  board.every((r) => r.cells.every((c) => typeof c.dimension === 'string' && typeof r.type === 'string')),
);

const riskCells = r1.material_risk ?? [];
const perfRows = r1.performance ?? [];
check('报告含 material_risk', Array.isArray(riskCells) && riskCells.length === 4);
check('报告含 performance', Array.isArray(perfRows) && perfRows.length === 4);

// 复算：material_risk 的 risk_score 必须能由 claims 独立算出
const re = recomputeRisk(String(rich.id));
let recomputeOk = true;
const recomputeDetail = [];
for (const cell of riskCells) {
  const expect = re.risk[cell.dimension] ?? null;
  if (expect !== cell.risk_score) {
    recomputeOk = false;
    recomputeDetail.push(`${cell.dimension}: 报告 ${cell.risk_score} vs 复算 ${expect}`);
  }
  const abs = re.absence[cell.dimension] ?? 0;
  if (abs !== cell.absence) {
    recomputeOk = false;
    recomputeDetail.push(`${cell.dimension}: absence 报告 ${cell.absence} vs 复算 ${abs}`);
  }
}
check('risk_score 可由 claims 复算一致（DoD）', recomputeOk, recomputeDetail.join('; ') || '四维全对');

// 两种总分：必须与各自格子同口径
const num = riskCells.reduce((s, c) => s + (c.risk_score ?? 0) * c.claims, 0);
const den = riskCells.reduce((s, c) => s + (c.risk_score === null ? 0 : c.claims), 0);
const expectOverall = den > 0 ? Math.round(num / den) : null;
check('overallRisk 与四格加权一致', ctx1.overallRisk === expectOverall, `页面 ${ctx1.overallRisk} vs 复算 ${expectOverall}`);

const perfHit = perfRows.filter((p) => typeof p.score === 'number');
const expectPerf = perfHit.length ? Math.round(perfHit.reduce((s, p) => s + p.score, 0) / perfHit.length) : null;
check('overallPerf 与本场问到的维度均值一致', ctx1.overallPerf === expectPerf, `页面 ${ctx1.overallPerf} vs 复算 ${expectPerf}`);
check('报告页拿得到 MOCK 事实', ctx1.mock === false);
check('首场 drillFrom 为空', ctx1.drillFrom == null);

// ══════════ 3) drill：只比临场表现 ══════════
const drill = await runSession('3 · drill（同一材料练回答）', {
  docId: String(rich.id),
  mode: 'drill',
  drillFrom: base.sessionId,
});
if (!drill?.end?.ok) { console.error('✖ drill 流程失败'); process.exit(1); }
const r2 = drill.end;
console.log('  delta =', JSON.stringify(r2.delta)?.slice(0, 400));
check('drill 报告带 delta', Boolean(r2.delta));
check('delta.kind = drill', r2.delta?.kind === 'drill', String(r2.delta?.kind));
check('drill 的 risk 分差恒为空（不出现 −0）', Array.isArray(r2.delta?.risk) && r2.delta.risk.length === 0);
check('drill 不比较材料（无 claim 增删）', r2.delta?.claims === undefined);
check(
  'drill 的 perf 行里没有 prev===now 的假对比',
  (r2.delta?.perf ?? []).every((d) => d.prev !== d.now),
  (r2.delta?.perf ?? []).map((d) => `${d.dimension}:${d.prev}→${d.now}`).join(' '),
);
const rep2 = await get(`/api/reports/${drill.sessionId}`);
check('drill 报告的 drillFrom 指回上一场', rep2.json?.context?.drillFrom === base.sessionId);

// ══════════ 4) revise：risk 分差 + claim 增删 ══════════
const revise = await runSession('4 · revise（改后材料重审）', {
  docId: String(other.id),
  mode: 'revise',
  drillFrom: base.sessionId,
});
if (!revise?.end?.ok) { console.error('✖ revise 流程失败'); process.exit(1); }
const r3 = revise.end;
console.log('  delta =', JSON.stringify(r3.delta)?.slice(0, 600));
check('revise 报告带 delta', Boolean(r3.delta));
check('delta.kind = revise', r3.delta?.kind === 'revise', String(r3.delta?.kind));
check('revise 的 perf 分差恒为空（两边问的问题不同，比不了表现）', Array.isArray(r3.delta?.perf) && r3.delta.perf.length === 0);
check('revise 带质疑点增删', Boolean(r3.delta?.claims));
const cd = r3.delta?.claims;
check(
  '质疑点总数两场都记了',
  typeof cd?.prevTotal === 'number' && typeof cd?.nowTotal === 'number',
  `${cd?.prevTotal} → ${cd?.nowTotal}`,
);
check(
  '两场材料的质疑点确实不同（否则这条对比没有信息）',
  cd?.prevTotal !== cd?.nowTotal || (cd?.added?.length ?? 0) + (cd?.removed?.length ?? 0) > 0,
  `kept=${cd?.kept} added=${cd?.added?.length} removed=${cd?.removed?.length}`,
);
check(
  'risk 分差行里没有 dir=0',
  (r3.delta?.risk ?? []).every((d) => d.prev !== d.now),
  (r3.delta?.risk ?? []).map((d) => `${d.dimension}:${d.prev}→${d.now}`).join(' '),
);

// ══════════ 5) 页面可打开 ══════════
console.log('\n【5】页面可打开');
for (const [label, url] of [
  ['quick 报告页', `/report/${base.sessionId}`],
  ['drill 报告页', `/report/${drill.sessionId}`],
  ['revise 报告页', `/report/${revise.sessionId}`],
]) {
  const r = await fetch(`${BASE}${url}`);
  const html = await r.text();
  check(`${label} 200`, r.status === 200, url);
  check(`${label} 是客户端壳`, html.includes('正在读取报告'), '报告数据由 /api/reports 拉取');
}

// ══════════ 汇总 ══════════
console.log('\n' + '═'.repeat(72));
const pass = checks.filter((c) => c.pass).length;
console.log(`判定：${pass} / ${checks.length} 通过`);
const failed = checks.filter((c) => !c.pass);
if (failed.length > 0) {
  console.log('未通过项：');
  for (const f of failed) console.log(`  ✖ ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
}
console.log('\n可看的页面：');
console.log(`  quick  http://127.0.0.1:3111/report/${base.sessionId}`);
console.log(`  drill  http://127.0.0.1:3111/report/${drill.sessionId}`);
console.log(`  revise http://127.0.0.1:3111/report/${revise.sessionId}`);
process.exit(failed.length === 0 ? 0 : 1);
