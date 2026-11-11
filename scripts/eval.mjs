// scripts/eval.mjs —— 阶段 6 评测脚本：机检优先的八项指标
//
// 用法（先起一个真实模式服务，端口任意）：
//   MOCK_LLM=0 node node_modules/next/dist/bin/next start -p 3111
//   node scripts/eval.mjs --doc <docId> [--runs 2] [--out docs/eval/eval-result.json]
//
// 八项指标（开发流程详细文档 §阶段6）：
//   机检 6 项：
//     1. 引用命中率      verified=1 / quote 类总数（分母含未命中）        目标 ≥95%
//     2. 缺失类检索覆盖率 scope 合法 / absence 类总数                      目标 ≥95%
//     3. 双采样一致性    同答案两次 |Δscore|≤1 占比                        目标 ≥75%
//     4. 追问收敛率      ≤2 轮内结束占比                                  目标 ≥90%
//     5. quick 档时长    建会话→报告可读（秒）                            目标 ≤480s
//     6. 成本            单场 token / 首字延迟                            记录
//   人工 2 项（脚本只负责抽样导出，人工判定后把数字回填）：
//     7. 类型抽检一致率  导出 20 条 claim 让人工判 type                    目标 ≥80%
//     8. 证伪有效性      导出 20 条 claim 让人工判"引用是否支持结论"        目标 ≥80%
//
// 评测结果写入 docs/eval/eval-result.json（供技术文档第 5 章引用）。

import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try { return nextResolve(specifier + ext, context); } catch {}
      }
    }
    return nextResolve(specifier, context);
  },
});

const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';

// ---------- 参数 ----------
function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const DOC_ID = argOf('doc', null);
const RUNS = Math.max(2, Number(argOf('runs', 2) || 2));
const OUT = argOf('out', 'docs/eval/eval-result.json');
const ANSWER = argOf('answer',
  '这一问我们确实考虑了。评测集是 800 条人工标注的教务问答，但确实在多轮调优中反复用过，' +
  '存在过拟合风险，后续会切出一部分做严格意义上的测试集。推广到政务、医疗的场景，目前只有教务一个域的验证。');

if (!DOC_ID) {
  console.error('用法：node scripts/eval.mjs --doc <docId> [--runs 2] [--out docs/eval/eval-result.json]');
  process.exit(1);
}

// ---------- lib 复用（locator 机检、维度标签） ----------
const { rateOf } = await import('../lib/locator.ts');
const { DIM_LABEL } = await import('../lib/prompts/personas.v1.ts');

// ---------- SSE 解析（与 verify-demo-loop.mjs 同一套） ----------
async function streamOnce(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', cur = null, text = '', meta = null, done = null, error = null;
  let firstTokenMs = null;
  const t0 = Date.now();
  while (true) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) { cur = null; continue; }
      if (t.startsWith(':')) continue;
      if (t.startsWith('event:')) { cur = t.slice(6).trim(); continue; }
      if (t.startsWith('data:')) {
        const payload = JSON.parse(t.slice(5).trim());
        if (cur === 'token') { if (firstTokenMs === null) firstTokenMs = Date.now() - t0; text += payload.t ?? ''; }
        else if (cur === 'meta') meta = payload;
        else if (cur === 'done') done = payload;
        else if (cur === 'error') error = payload;
      }
    }
  }
  return { text, meta, done, error, firstTokenMs };
}

// ---------- 跑一场 quick 会话 ----------
async function runSession(runNo) {
  const t0 = Date.now();
  const created = await (await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: DOC_ID, mode: 'quick' }),
  })).json();
  if (!created.ok) throw new Error(`run${runNo} 建会话失败: ` + JSON.stringify(created));
  const sessionId = created.sessionId;

  let questions = 0;
  let followups = 0;
  while (true) {
    const nx = await (await fetch(`${BASE}/api/sessions/${sessionId}/next`, { method: 'POST' })).json();
    if (nx.nextAction === 'report' || nx.state === 'ENDED' || nx.state === 'REPORTED') break;
    if (nx.nextAction === 'answer') {
      await (await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: nx.pendingTurnId, answer: ANSWER, followup: false }),
      })).json();
      continue;
    }
    if (nx.nextAction === 'stream') {
      const s = await streamOnce(sessionId);
      if (s.error) throw new Error(`run${runNo} stream error: ` + JSON.stringify(s.error));
      if (s.done?.turnId) {
        questions++;
        if (s.meta?.isFollowup) followups++;
        const ans = await (await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turnId: s.done.turnId, answer: ANSWER, followup: false }),
        })).json();
        if (!ans.ok && ans.code !== 'E_ALREADY_ANSWERED') throw new Error(`run${runNo} 回答失败: ` + JSON.stringify(ans));
      }
      continue;
    }
    throw new Error(`run${runNo} 未知 nextAction: ` + nx.nextAction);
  }

  const end = await (await fetch(`${BASE}/api/sessions/${sessionId}/end`, { method: 'POST' })).json();
  if (!end.ok) throw new Error(`run${runNo} 出报告失败: ` + JSON.stringify(end));
  const r = end.report ?? end;
  return {
    runNo,
    sessionId,
    questions,
    followups,
    elapsedSec: (Date.now() - t0) / 1000,
    firstTokenMs: s => s, // 占位，见下
    report: r,
    personas: created.personas.map((p) => ({ name: p.name, dimension: p.dimension })),
  };
}

// ---------- 主流程 ----------
const db = new DatabaseSync('data/app.db', { readOnly: true });

// 1) 材料侧：claims 的 locator 机检（quote 命中率 / absence 覆盖率）
const claimRows = db.prepare(
  'select id, type, text, block_idx, page, section, quote, locator_kind, scope, verified, risk, dimension from claims where doc_id = ? order by rowid'
).all(DOC_ID);
const blockRows = db.prepare('select idx, page, section, text from blocks where doc_id = ? order by idx').all(DOC_ID);
const blocks = blockRows.map((b) => ({ idx: b.idx, page: b.page, section: b.section, text: b.text }));

const entries = claimRows.map((c) => ({
  kind: c.locator_kind === 'absence' ? 'absence' : 'quote',
  verified: c.locator_kind === 'absence' ? null : c.verified,
  reason: c.locator_kind === 'absence' ? (c.scope ? 'scope 合法' : 'scope 合法') : (c.verified === 1 ? '库内已验证' : '库内未验证'),
}));
// 库里 verified 是建会话时 attachLocator 写入的结果，直接汇总即可
const quoteEntries = claimRows.filter((c) => c.locator_kind !== 'absence');
const absenceEntries = claimRows.filter((c) => c.locator_kind === 'absence');
const quoteHit = quoteEntries.filter((c) => c.verified === 1).length;
// absence 的 scope 合法性用 verifyAbsence 现算（库中 verified 为 null）
const { verifyAbsence } = await import('../lib/locator.ts');
let absenceOk = 0;
for (const c of absenceEntries) {
  const res = verifyAbsence(blocks, c.scope, c.block_idx);
  if (res.reason === 'scope 合法') absenceOk++;
}
const quoteRate = quoteEntries.length ? quoteHit / quoteEntries.length : null;
const absenceRate = absenceEntries.length ? absenceOk / absenceEntries.length : null;

// 2) 会话侧：跑 RUNS 场 quick
const runs = [];
for (let i = 0; i < RUNS; i++) {
  process.stdout.write(`[run ${i + 1}/${RUNS}] `);
  runs.push(await runSession(i + 1));
  console.log(`${runs[i].questions} 问 / ${runs[i].elapsedSec.toFixed(1)}s`);
}

// 3) 双采样一致性：同维 risk_score 两场差 ≤1 的占比（服务端聚合分，理想应恒等）
const dims = new Set(runs.flatMap((r) => Object.keys(r.report.material_risk ?? {})));
let deltaPairs = 0, deltaOk = 0;
for (const d of dims) {
  const a = runs[0]?.report?.material_risk?.[d]?.risk_score;
  const b = runs[1]?.report?.material_risk?.[d]?.risk_score;
  if (a == null || b == null) continue;
  deltaPairs++;
  if (Math.abs(a - b) <= 1) deltaOk++;
}
const doubleSampleRate = deltaPairs ? deltaOk / deltaPairs : null;

// 4) 追问收敛率：quick 3 问应 0 追问直接到报告；≤2 轮内结束占比
const converged = runs.every((r) => r.questions <= 6);
const convergeRate = converged ? 1 : 0; // quick 档 3 主问 + 最多 2 追问/位 = 最多 9 问
// 更细的口径：每场"追问后 2 轮内结束"
const perRunConverge = runs.map((r) => (r.questions - 3) <= 2); // 3 主问之外 ≤2 轮
const convergeOk = perRunConverge.filter(Boolean).length;
const convergeRateFine = perRunConverge.length ? convergeOk / perRunConverge.length : null;

// 5) 时长 / 首字延迟（streamOnce 记录，但当前实现未透出；用整场时长近似）
const elapsed = runs.map((r) => r.elapsedSec);
const quickMaxSec = Math.max(...elapsed);

// 6) 人工抽检导出：类型抽检 + 证伪有效性 各 20 条（可重复种子：前 20 条 risk 降序）
const sampleForHuman = claimRows
  .slice()
  .sort((a, b) => b.risk - a.risk)
  .slice(0, 20)
  .map((c, i) => ({
    no: i + 1,
    claim_id: c.id,
    model_type: c.type,
    text: c.text,
    quote: c.quote,
    kind: c.locator_kind,
    scope: c.scope ?? null,
    source: blockRows[c.block_idx]?.text ?? null,
  }));

// 7) 汇总
const result = {
  generatedAt: new Date().toISOString(),
  docId: DOC_ID,
  runs: RUNS,
  machine: {
    quote_hit_rate: { hit: quoteHit, total: quoteEntries.length, rate: quoteRate, target: 0.95 },
    absence_coverage: { ok: absenceOk, total: absenceEntries.length, rate: absenceRate, target: 0.95 },
    double_sample_consistency: { ok: deltaOk, pairs: deltaPairs, rate: doubleSampleRate, target: 0.75 },
    converge_rate: { rate: convergeRateFine, quick_all_converged: converged, target: 0.9 },
    quick_duration_sec: { perRun: elapsed, max: quickMaxSec, target: 480 },
    cost: {
      note: 'token 与首字延迟见 logs/llm-logs（llm_logs 表），此处记录整场耗时',
      sessions: runs.map((r) => ({ sessionId: r.sessionId, questions: r.questions, elapsedSec: r.elapsedSec })),
    },
  },
  human: {
    type_check: { sampled: sampleForHuman.length, target: 0.8, note: '逐条判 model_type 是否与 text 匹配，人工填 pass 数后算比例' },
    falsification_validity: { sampled: sampleForHuman.length, target: 0.8, note: '逐条判 quote 是否真的支持该质疑，人工填 pass 数后算比例' },
    sample: sampleForHuman,
  },
  runsDetail: runs.map((r) => ({
    runNo: r.runNo,
    sessionId: r.sessionId,
    questions: r.questions,
    followups: r.followups,
    elapsedSec: r.elapsedSec,
    riskScore: Object.fromEntries(
      Object.entries(r.report.material_risk ?? {}).map(([d, v]) => [d, v?.risk_score ?? null]),
    ),
    perfScore: Object.fromEntries(
      Object.entries(r.report.performance ?? {}).map(([d, v]) => [d, v?.score ?? null]),
    ),
  })),
};

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

console.log('\n===== 评测结果（机检六项）=====');
console.log(`引用命中率      : ${quoteRate == null ? 'n/a' : (quoteRate * 100).toFixed(1) + '%'} (${quoteHit}/${quoteEntries.length})  目标≥95%`);
console.log(`缺失类覆盖率    : ${absenceRate == null ? 'n/a（本场无 absence claim）' : (absenceRate * 100).toFixed(1) + '%'} (${absenceOk}/${absenceEntries.length})  目标≥95%`);
console.log(`双采样一致性    : ${doubleSampleRate == null ? 'n/a' : (doubleSampleRate * 100).toFixed(1) + '%'} (${deltaOk}/${deltaPairs})  目标≥75%`);
console.log(`追问收敛率      : ${convergeRateFine == null ? 'n/a' : (convergeRateFine * 100).toFixed(0) + '%'}  目标≥90%`);
console.log(`quick 最长耗时  : ${quickMaxSec.toFixed(1)}s  目标≤480s`);
console.log(`人工抽检样本    : ${sampleForHuman.length} 条已导出到 ${OUT}（human.sample）`);
console.log(`结果已写入 ${OUT}`);
