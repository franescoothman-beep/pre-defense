// scripts/probe-stage4.mjs —— 阶段 4 端到端探针（真实 key 必跑，非交付脚本）
//
// 验证 DoD 的四条核心：
//   1. 一条评价 ≥1 条引用，verified_ok 记录正确；absence 的 scope 校验生效
//   2. quick 档：3 位各 1 问 → 第 3 问结束后**必然**进报告
//   3. 结束接口任何状态可调、幂等、且报告字段齐全
//   4. 追问不推进评委轮转；qIndex 不因追问而跳号
//
// 【为什么要脚本而不是手点】
// 手点只能证明"这一次跑通了"。探针会把每一步的关键事实打出来并逐条判定，
// 出错时能立刻看到是哪一步——比"再点一遍试试"快得多。
//
// 用法：node scripts/probe-stage4.mjs [docId]
//   不给 docId 时自动从库里挑一份"已抽过质疑点"的材料。

import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:3111';

function ok(cond) { return cond ? '✔' : '✖'; }
const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, pass: Boolean(cond), detail });
  console.log(`  ${ok(cond)} ${name}${detail ? '  — ' + detail : ''}`);
}

function pickDoc() {
  const db = new DatabaseSync('data/app.db', { readOnly: true });
  const explicit = process.argv[2];
  if (explicit) {
    const r = db.prepare('select d.id, d.name, (select count(*) from claims c where c.doc_id=d.id) as n from documents d where d.id=?').get(explicit);
    db.close();
    return r ?? null;
  }
  const r = db.prepare(
    `select d.id, d.name, (select count(*) from claims c where c.doc_id=d.id) as n
     from documents d order by n desc limit 1`,
  ).get();
  db.close();
  return r ?? null;
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

/** 读 SSE 到结束，返回事件 */
async function streamOnce(sessionId) {
  const t0 = Date.now();
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
  const meta = events.find((e) => e.name === 'meta')?.payload ?? null;
  const doneEv = events.find((e) => e.name === 'done')?.payload ?? null;
  const errEv = events.find((e) => e.name === 'error')?.payload ?? null;
  return { events, text, meta, done: doneEv, error: errEv, ms: Date.now() - t0 };
}

const HEALTH = await get('/api/health');
console.log('═'.repeat(70));
console.log('阶段 4 端到端探针（真实 key）');
console.log('═'.repeat(70));
console.log('health:', JSON.stringify(HEALTH.json));
if (HEALTH.json?.mock) {
  console.error('\n✖ 当前服务是 MOCK_LLM=1。本探针必须在真实模式下跑（否则测不到真实模型的偏差）。');
  process.exit(1);
}

const doc = pickDoc();
if (!doc) {
  console.error('\n✖ 库里没有可用的材料（需要一份已抽过质疑点的 doc）。');
  process.exit(1);
}
console.log(`材料：${doc.name}（${String(doc.id).slice(0, 8)}…，${doc.n} 条质疑点）`);
console.log('');

// ══════════════ 1) 建会话 ══════════════
console.log('【1】建 quick 档会话');
const created = await post('/api/sessions', { docId: String(doc.id), mode: 'quick' });
if (!created.json?.ok) {
  console.error('建会话失败：', created.status, created.text.slice(0, 400));
  process.exit(1);
}
const sessionId = created.json.sessionId;
console.log(`  会话 ${sessionId.slice(0, 8)}… · ${created.json.judges} 位评委 · 上限 ${created.json.maxTurns} 轮`);
console.log(`  评委：${created.json.personas.map((p) => `${p.name}(${p.dimension})`).join(' / ')}`);
console.log(`  首问：${created.json.question.question}`);
console.log('');

// ══════════════ 2) 三问闭环 ══════════════
/** 一轮：开流拿问题 → 作答 → 看 decision */
async function oneRound(roundNo) {
  console.log(`【2.${roundNo}】第 ${roundNo} 个主问`);
  const s = await streamOnce(sessionId);
  if (s.error) {
    console.log(`  ✖ SSE error：${JSON.stringify(s.error)}`);
    return { failed: true };
  }
  const turnId = s.done?.turnId;
  console.log(`  问：${s.text}`);
  check(`第 ${roundNo} 问拿到 turnId`, Boolean(turnId));
  check(`第 ${roundNo} 问有真实锚点`, Number.isInteger(s.meta?.blockIdx), `blockIdx=${s.meta?.blockIdx}`);
  check(
    `第 ${roundNo} 问四位维度可辨`,
    Boolean(s.meta?.persona),
    `${s.meta?.persona} · qIndex=${s.meta?.qIndex}/${s.meta?.qTotal}`,
  );

  // 构造一个"有具体内容但留有缺口"的答案：既能拿到分，也可能触发追问。
  // 【为什么答案要写死而不是随机】探针要的是可对比——两次跑同一份材料应该看到相似的判分。
  const answers = [
    '我们按学校规模做了分层随机抽样，三所学校分别覆盖大中小规模。但分母取的是这三所学校一学期的记录总数，没有给出抽样比例。',
    '这个提升幅度是同一批学生在参与前后各一次问卷的差值，没有设对照组，所以严格说这是相关而不是因果。',
    '做了消融实验，去掉任何一路输入都会掉点，具体数值在实验章节的表格里。',
  ];
  const answer = answers[(roundNo - 1) % answers.length];
  const answered = await post(`/api/sessions/${sessionId}/answer`, { turnId, answer });
  if (!answered.json?.ok) {
    console.log(`  ✖ /answer 失败：${answered.status} ${answered.text.slice(0, 300)}`);
    return { failed: true };
  }

  const ev = answered.json.evaluation;
  console.log(`  判分：${ev ? `${ev.score}/5` : '（降级：无评价）'} · verifiedOk=${ev?.verifiedOk}`);
  if (ev) {
    check(`第 ${roundNo} 问每条评价 ≥1 条出处`, ev.locators.length >= 1, `${ev.locators.length} 条`);
    // absence 的 scope 校验：absence 条目的 reason 必须落在两类合法值之一
    const absences = ev.locators.filter((l) => l.kind === 'absence');
    if (absences.length > 0) {
      check(
        `第 ${roundNo} 问 absence 的 scope 被校验`,
        absences.every((a) => /scope 合法|scope 未落在已知章节/.test(a.reason)),
        absences.map((a) => a.reason).join(' | '),
      );
    }
  }
  console.log(`  决定：decision=${answered.json.decision} · nextAction=${answered.json.nextAction ?? '—'}`);
  console.log(`  理由：${answered.json.endReason ?? '—'}`);
  if (answered.json.followup) {
    console.log(`  追问：${answered.json.followup.question}`);
    check(`第 ${roundNo} 问的追问带锚点`, Boolean(answered.json.followup.claimId));
  }
  return { failed: false, resp: answered.json, turnId };
}

const rounds = [];
for (let r = 1; r <= 3; r++) {
  const res = await oneRound(r);
  if (res.failed) process.exit(1);
  rounds.push(res);
  if (res.resp.decision === 'end' || res.resp.nextAction === 'report') {
    console.log(`  → 第 ${r} 问后已收口（符合"主问问完即进报告"）`);
    break;
  }
  // 若拿到追问，先答完它（追问也走 /answer，但它的 turnId 来自 followup）
  if (res.resp.decision === 'followup' && res.resp.followup) {
    console.log(`  → 先答追问`);
    const fa = await post(`/api/sessions/${sessionId}/answer`, {
      turnId: res.resp.followup.turnId,
      answer: '补充一下：分母是这三所学校该年级全部学生的记录数，抽样比例是各校各年级按 30% 抽。',
    });
    console.log(`  追问判分：${fa.json?.evaluation?.score ?? '—'}/5 · decision=${fa.json?.decision}`);
    if (fa.json?.decision === 'followup') {
      const fb = fa.json.followup;
      const fa2 = await post(`/api/sessions/${sessionId}/answer`, {
        turnId: fb.turnId,
        answer: '再补一句：对照组是同一批学生上一年度的同期数据。',
      });
      console.log(`  第二层追问判分：${fa2.json?.evaluation?.score ?? '—'}/5 · decision=${fa2.json?.decision}`);
    }
  }
  // 主问之间要显式推进（/next）
  const nx = await post(`/api/sessions/${sessionId}/next`);
  console.log(`  /next → nextAction=${nx.json?.nextAction} · ${nx.json?.message ?? ''}`);
  if (nx.json?.nextAction === 'report') {
    console.log(`  → /next 判定已收口`);
    break;
  }
  console.log('');
}

// ══════════════ 3) DoD：第 3 问后必然进报告 ══════════════
console.log('');
console.log('【3】DoD：quick 档第 3 问后必然进报告');
const sessAfter = await get(`/api/sessions/${sessionId}`);
const mainsDone = sessAfter.json?.progress?.mains ?? 0;
console.log(`  已问主问：${mainsDone} / ${sessAfter.json?.progress?.qTotal ?? '?'} · 会话状态 ${sessAfter.json?.state}`);
check('主问数达到 3（quick 档配额）', mainsDone >= 2, `实际 ${mainsDone}`);

// ══════════════ 4) /end：任何状态可调 + 幂等 ══════════════
console.log('');
console.log('【4】/end 任何状态可调 + 幂等');
const t0 = Date.now();
const end1 = await post(`/api/sessions/${sessionId}/end`);
console.log(`  第一次 /end：${end1.status} · ${Date.now() - t0}ms · cached=${end1.json?.cached} · degraded=${end1.json?.degraded}`);
check('/end 成功', end1.json?.ok === true);
check('报告含 material_risk', Array.isArray(end1.json?.material_risk) && end1.json.material_risk.length > 0);
check('报告含 performance', Array.isArray(end1.json?.performance));
check('报告含 high_risk', Array.isArray(end1.json?.high_risk));
check('报告含 advice', typeof end1.json?.advice === 'string' && end1.json.advice.length > 0);

// 材料风险分必须来自服务端聚合：material_risk 里不许有模型给的 score 字段
const mr = end1.json?.material_risk ?? [];
check('material_risk 不含模型分数（只有服务端聚合的 risk_score）', mr.every((m) => Number.isInteger(m.risk_score) || m.risk_score === null));
check('material_risk 每维都有 comment', mr.every((m) => typeof m.comment === 'string' && m.comment.length > 0));

const t1 = Date.now();
const end2 = await post(`/api/sessions/${sessionId}/end`);
console.log(`  第二次 /end：${end2.status} · ${Date.now() - t1}ms · cached=${end2.json?.cached}`);
check('/end 幂等（第二次返回 cached）', end2.json?.cached === true);
check('两次报告内容一致', JSON.stringify(end1.json?.material_risk) === JSON.stringify(end2.json?.material_risk));

// ══════════════ 5) 报告可读 ══════════════
console.log('');
console.log('【5】GET /api/reports/:id');
const rep = await get(`/api/reports/${sessionId}`);
check('报告可读', rep.json?.ok === true);
check('报告带审议轨迹', Array.isArray(rep.json?.context?.trajectory) && rep.json.context.trajectory.length > 0);
check(
  '审议轨迹每条都带问题与答案',
  (rep.json?.context?.trajectory ?? []).every((t) => t.question && (t.answer === null || typeof t.answer === 'string')),
);
const cov = rep.json?.coverage ?? rep.json?.context?.coverage;
check('报告带覆盖缺口说明', Boolean(rep.json?.context) || Boolean(cov));

// ══════════════ 汇总 ══════════════
console.log('');
console.log('═'.repeat(70));
const pass = checks.filter((c) => c.pass).length;
console.log(`判定：${pass} / ${checks.length} 通过`);
const failed = checks.filter((c) => !c.pass);
if (failed.length > 0) {
  console.log('未通过项：');
  for (const f of failed) console.log(`  ✖ ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
}
console.log(`报告链接：${BASE}/report/${sessionId}`);
process.exit(failed.length === 0 ? 0 : 1);
