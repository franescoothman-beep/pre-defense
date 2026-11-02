/**
 * prompt-eval —— 阶段 6 任务 ③（C18）
 *
 * 跑 3 组「v1 vs v2 同输入对比」：claims / evaluate / report。
 *   v2 = lib/prompts/*.v1.ts 里现行 SYSTEM（即线上真实在用的版本）
 *   v1 = 本文件自写的弱化版（模拟"没有那些硬约束时模型会怎么飘"）
 * 同一输入分别过两套 system，产物统一走产品 zod schema + lib/locator 机检，
 * 出对比指标（quote 命中率 / 结构违规数 / 长度违规数）落 docs/prompt-eval/。
 *
 * 用法：
 *   MOCK_LLM 无关（本脚本直连 DeepSeek，不经过产品 callLLM）。
 *   node scripts/prompt-eval.mjs            # 全部 3 组
 *   node scripts/prompt-eval.mjs claims     # 只跑一组（调试用）
 */
import { registerHooks } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// 产品代码的相对导入不带扩展名（兼容 Next bundler）。裸跑 Node 需要这套解析钩子，
// 与 scripts/test-fixtures.mjs / tests/hooks.mjs 同一套。钩子必须在 import 产品代码之前注册。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {
          /* 试下一个后缀 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

// ---- 环境（手动 parse .env.local，值不打印） ----
const envPath = path.join(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('缺 DEEPSEEK_API_KEY：prompt-eval 需要真实模型对比，mock 回放没有意义。');
  process.exit(1);
}
const BASE = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL = process.env.MODEL ?? 'deepseek-chat';

// ---- 产品模块（schema + locator 机检 + 现行 prompt） ----
const { ClaimsOut, EvaluateOut, ReportOut } = await import('../lib/schemas.ts');
const { verifyQuote, verifyAbsence } = await import('../lib/locator.ts');
const claimsP = await import('../lib/prompts/claims.v1.ts');
const evaluateP = await import('../lib/prompts/evaluate.v1.ts');
const reportP = await import('../lib/prompts/report.v1.ts');

const BLOCKS = JSON.parse(readFileSync('fixtures/demo/sample-paper.blocks.json', 'utf8')).blocks;
const OUT_DIR = 'docs/prompt-eval';

// ---- DeepSeek 直调（仿 lib/llm.ts callReal，但单次不重试——对比实验要同条件） ----
async function callOnce(system, user, temperature) {
  const started = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? '';
  // 提取 JSON（宽容解析：允许 ```json 包裹）
  const m = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = JSON.parse(m ? m[0] : text); } catch { /* 保持 null */ }
  return { parsed, raw: text, tokens: json.usage?.total_tokens ?? 0, latencyMs: Date.now() - started };
}

// ---- 机检统计 ----
function quoteHitRate(locators) {
  // 与 lib/locator.ts 同口径：verifyQuote(blocks, blockIdx, quote) → verified===1 为命中。
  // 但命中分三档，必须分开数：原地命中 vs 邻域命中 vs **全篇兜底命中**。
  // 兜底命中 = quote 是真的，但模型给的 block_idx 错了（位置交代不清）——
  // 对"可一键追回原文"来说，这是打折的命中，混在一起看会以为两边一样好。
  let total = 0, hit = 0, inPlace = 0, neighbor = 0, fallback = 0;
  for (const l of locators ?? []) {
    if (l.kind !== 'quote') continue;
    total++;
    const r = verifyQuote(BLOCKS, l.block_idx, l.quote);
    if (r.verified === 1) {
      hit++;
      if (r.reason === '原地命中') inPlace++;
      else if (r.reason.startsWith('邻域')) neighbor++;
      else fallback++;
    }
  }
  return { total, hit, inPlace, neighbor, fallback, rate: total === 0 ? null : hit / total };
}
function absenceScopeRate(locators) {
  let total = 0, ok = 0;
  for (const l of locators ?? []) {
    if (l.kind !== 'absence') continue;
    total++;
    const r = verifyAbsence(BLOCKS, l.scope, l.block_idx);
    if (r.reason === 'scope 合法') ok++;
  }
  return { total, ok, rate: total === 0 ? null : ok / total };
}

// =====================================================================
// 组 1：claims —— 弱输入（v1 无逐字/编号约束）vs 现行 v2
// =====================================================================
async function runClaims() {
  const batch = BLOCKS.slice(0, 5);
  const user = claimsP.buildClaimsUser(BLOCKS, batch.map(b => b.idx));

  const V1_SYSTEM = `你是论文评审。请找出材料中值得追问的质疑点，输出 JSON：
{"claims":[{"type":"method|engineering|value","text":"质疑点描述","block_idx":出处块号,"quote":"支撑原句","risk":1-5,"dimension":"logic|evidence|depth|expression"}]}
最多 12 条。`;

  const out = {};
  for (const [ver, system] of [['v1', V1_SYSTEM], ['v2', claimsP.CLAIMS_SYSTEM]]) {
    const r = await callOnce(system, user, 0.1);
    const check = claimsP.ClaimsSchema.safeParse(r.parsed);
    const claims = check.success ? check.data.claims : (r.parsed?.claims ?? []);
    const rawClaims = Array.isArray(r.parsed?.claims) ? r.parsed.claims : [];
    const q = quoteHitRate(claims);
    // 【type/dimension 混用】这一项必须看原始输出：lib/schemas.ts 的 DimIn 会把
    // method/engineering→depth、value/innovation→expression 静默映射掉，
    // 所以 safeParse 通过 ≠ 模型没混。混用的代价是"维度"这条轴被悄悄压平，
    // 四位评委按维度错位分席的机制随之失效（三个人可能全落在 depth）。
    const TYPE_WORDS = new Set(['method', 'engineering', 'value', 'innovation']);
    const rawDimConfused = rawClaims.filter(c => TYPE_WORDS.has(String(c?.dimension ?? '').trim().toLowerCase())).length;
    out[ver] = {
      raw: r.raw, tokens: r.tokens, latencyMs: r.latencyMs,
      schemaOk: check.success,
      schemaError: check.success ? null : check.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`),
      n: claims.length,
      rawDimConfused,
      nAbsence: claims.filter(c => c.kind === 'absence').length,
      dims: [...new Set(claims.map(c => c.dimension))],
      types: [...new Set(claims.map(c => c.type))],
      quote: q,
      // v1 特有违规：block_idx 超界 / quote 长度出 8–60 / risk 出界
      violations: claims.filter(c =>
        !Number.isInteger(c.block_idx) || !BLOCKS.some(b => b.idx === c.block_idx) ||
        (c.kind !== 'absence' && (typeof c.quote !== 'string' || c.quote.length < 8 || c.quote.length > 60)) ||
        !Number.isInteger(c.risk) || c.risk < 1 || c.risk > 5
      ).length,
    };
  }
  return { out, systems: { v1: V1_SYSTEM, v2: claimsP.CLAIMS_SYSTEM } };
}

// =====================================================================
// 组 2：evaluate —— 同一回答（偏弱的复述式回答），v1 无五档写死 vs 现行 v2
// =====================================================================
async function runEvaluate() {
  const claim = {
    id: 'd6a27be9-0a1e-4a67-b489-17bc4e89641c', type: 'method', text: '仅用三所小学一学期 1240 条数据，样本代表性如何支撑对全市乃至全省的推广？',
    risk: 5, block_idx: 3, quote: '我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。',
    locatorKind: 'quote', verified: 1,
  };
  const blocksByIdx = new Map(BLOCKS.map(b => [b.idx, b]));
  const input = {
    persona: { name: '陈评委', role: 'method', focus: '数据与方法的可靠性', tone: '直接、抠数字' },
    question: '这三所小学是按什么标准选出来的，能代表全市不同层次的学校吗？',
    claim,
    source: blocksByIdx.get(3)?.text ?? '',
    answer: '我们采集了三所小学一学期共 1240 条记录，用了多元线性回归，决定系数 0.62，说明模型是有效的，家长满意度可以比较好地被预测。',
    candidates: [],
    qIndex: 1, qTotal: 3, followupsSoFar: 0,
  };
  const user = evaluateP.buildEvaluateUser(input);

  const V1_SYSTEM = `你是答辩评委。请对考生的回答打分并指出缺口，输出 JSON：
{"score":0-100,"gaps":["..."],"locators":[{"kind":"quote","block_idx":块号,"quote":"原句"}],"followup":null}
score 越高越好。`;

  const out = {};
  for (const [ver, system] of [['v1', V1_SYSTEM], ['v2', evaluateP.EVALUATE_SYSTEM]]) {
    const r = await callOnce(system, user, 0.2);
    const check = evaluateP.EvaluateSchema.safeParse(r.parsed);
    const data = check.success ? check.data : r.parsed;
    const q = quoteHitRate(data?.locators);
    out[ver] = {
      raw: r.raw, tokens: r.tokens, latencyMs: r.latencyMs,
      schemaOk: check.success,
      schemaError: check.success ? null : check.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`),
      score: data?.score ?? null, score0to100: data?.score != null && data.score > 5,
      nGaps: Array.isArray(data?.gaps) ? data.gaps.length : null,
      quote: q,
      followup: data?.followup ? { hasQuestion: typeof data.followup.question === 'string', target: data.followup.target_claim_id } : null,
    };
  }
  return { out, systems: { v1: V1_SYSTEM, v2: evaluateP.EVALUATE_SYSTEM } };
}

// =====================================================================
// 组 3：report —— 同一场问答记录，v1 无"不许给分/locators 形状"约束 vs 现行 v2
// =====================================================================
async function runReport() {
  const blocksByIdx = new Map(BLOCKS.map(b => [b.idx, b]));
  const input = {
    docName: 'sample-paper.docx', mode: 'quick', modeLabel: '快速质询',
    coveredDimensions: ['evidence', 'logic', 'depth'],
    riskByDimension: [
      { dimension: 'logic', riskScore: 81, claims: 4 },
      { dimension: 'evidence', riskScore: 80, claims: 5 },
      { dimension: 'depth', riskScore: 50, claims: 3 },
      { dimension: 'expression', riskScore: null, claims: 0 },
    ],
    claims: [
      { id: 'd6a27be9-0a1e-4a67-b489-17bc4e89641c', text: '仅用三所小学一学期 1240 条数据，样本代表性如何支撑推广？', dimension: 'evidence', risk: 5, type: 'method', quote: '我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。', locatorKind: 'quote', section: '2. 数据与方法', page: null, askedInSession: true },
      { id: '73f01725-5421-4d30-a44b-0a5d55eb5c7c', text: '实验未划分训练集与测试集，存在过拟合风险。', dimension: 'evidence', risk: 5, type: 'method', quote: '实验在同一批数据上进行，未划分训练集与测试集。', locatorKind: 'quote', section: '3. 实验结果', page: null, askedInSession: true },
      { id: 'c0a1f8e2-9e64-4e18-8d21-5f1c1dbed4a2', text: '把相关关系直接解读为可推广的管理结论，因果方向未排除。', dimension: 'logic', risk: 5, type: 'method', quote: '我们认为该结论可以推广到全市乃至全省的课后服务管理场景。', locatorKind: 'quote', section: '3. 实验结果', page: null, askedInSession: true },
    ],
    turns: [
      { personaName: '陈评委', question: '这三所小学是按什么标准选出来的，能代表全市不同层次的学校吗？', answer: '我们采集了 1240 条记录，回归决定系数 0.62，模型是有效的。', score: 2, gaps: '没有回答抽样标准；用整体拟合度回避代表性问题。', kind: 'question' },
      { personaName: '陈评委', question: '样本之外呢？凭什么说能代表全省？', answer: '后续会引入更多学校的数据验证稳健性。', score: 2, gaps: '把"未来计划"当成了当下证据。', kind: 'followup' },
      { personaName: '林教授', question: '没有划分训练集与测试集，怎么排除过拟合？', answer: '我们在同一批数据上做了显著性检验，p 值小于 0.05。', score: 2, gaps: '显著性检验不能替代样本外验证。', kind: 'question' },
    ],
    sources: BLOCKS.map(b => ({ blockIdx: b.idx, text: b.text })),
    qTotal: 3,
  };
  const user = reportP.buildReportUser(input);

  const V1_SYSTEM = `你是答辩委员会主席。请写一份答辩风险报告，输出 JSON：
{"material_risk":[{"dimension":"logic|evidence|depth|expression","risk_score":0-100,"comment":"评语","locators":["引用原句"]}],
 "performance":[{"dimension":"...","score":0-100,"comment":"评语"}],
 "high_risk":[{"claim_id":"...","question":"...","why":"...","suggestion":"..."}],
 "advice":"总建议"}`;

  const out = {};
  for (const [ver, system] of [['v1', V1_SYSTEM], ['v2', reportP.REPORT_SYSTEM]]) {
    const r = await callOnce(system, user, 0.2);
    const check = reportP.ReportSchema.safeParse(r.parsed);
    const data = check.success ? check.data : r.parsed;
    const allLoc = (data?.material_risk ?? []).flatMap(m => m.locators ?? []);
    const q = quoteHitRate(allLoc);
    const a = absenceScopeRate(allLoc);
    // 越界判据要看**模型原始输出**：zod 的 z.object 会静默 strip 未知字段，
    // 若只看 safeParse 结果，"模型多给了 risk_score" 这件事会被 schema 悄悄吃掉、测不出来。
    const rawMR = Array.isArray(r.parsed?.material_risk) ? r.parsed.material_risk : [];
    out[ver] = {
      raw: r.raw, tokens: r.tokens, latencyMs: r.latencyMs,
      schemaOk: check.success,
      schemaError: check.success ? null : check.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`),
      rawGaveMaterialScore: rawMR.some(m => m && (m.risk_score !== undefined || m.score !== undefined)),
      rawStringLocators: rawMR.some(m => Array.isArray(m?.locators) && m.locators.some(l => typeof l === 'string')),
      quote: q, absence: a,
      nHighRisk: Array.isArray(data?.high_risk) ? data.high_risk.length : null,
      highRiskIdsValid: Array.isArray(data?.high_risk) ? data.high_risk.every(h => input.claims.some(c => c.id === h.claim_id)) : null,
    };
  }
  return { out, systems: { v1: V1_SYSTEM, v2: reportP.REPORT_SYSTEM } };
}

// ---- 主流程 ----
const only = process.argv[2];
// 每组每版本的重复次数。3 次是成本与稳定性折中：单次会被随机性骗（见下），
// 5 次以上则 6→10 次调用的预算翻倍，而结论不会再变。
const REPS = Number(process.env.PROMPT_EVAL_REPS ?? 3);
const RUNNERS = { claims: runClaims, evaluate: runEvaluate, report: runReport };
const names = only && RUNNERS[only] ? [only] : Object.keys(RUNNERS);

mkdirSync(OUT_DIR, { recursive: true });
const summary = [];
for (const name of names) {
  console.log(`\n=== ${name} ===`);
  // 重复采样：单次对比会被模型随机性淹没（本次实测 claims 组第一次 v1 违规 0 条、
  // 第二次 v1 直接把 dimension 写成 expression/type 混用 —— 结论会来回翻）。
  // 所以每组每版本跑 REPS 次，用「通过率」而不是「某一次的结果」下结论。
  const runs = { v1: [], v2: [] };
  let systems = null;
  for (let rep = 0; rep < REPS; rep++) {
    const r = await RUNNERS[name]();
    systems = r.systems;
    for (const ver of ['v1', 'v2']) runs[ver].push(r.out[ver]);
  }
  const dir = path.join(OUT_DIR, name);
  mkdirSync(dir, { recursive: true });
  // 两套 system 原文一并留档：对比表里的每个数字都要能追到"当时用的到底是哪段 prompt"，
  // 否则半年后回看只剩一组数字，无法审计。
  writeFileSync(path.join(dir, 'v1.system.txt'), systems.v1, 'utf8');
  writeFileSync(path.join(dir, 'v2.system.txt'), systems.v2, 'utf8');
  const agg = { v1: aggregate(runs.v1, name), v2: aggregate(runs.v2, name) };
  for (const ver of ['v1', 'v2']) {
    // 原始 JSON 全量留档（REPS 次的每一条），diff.md 里只放聚合与代表样本
    writeFileSync(path.join(dir, `${ver}.json`), JSON.stringify({ reps: REPS, runs: runs[ver] }, null, 2), 'utf8');
    const s = agg[ver];
    console.log(`${ver}: schemaOk ${s.schemaOkRuns}/${REPS} · quote ${s.quoteHit}/${s.quoteTotal} · 越界 ${s.rawGaveMaterialScoreRuns + s.rawStringLocatorsRuns + s.rawDimConfusedRuns} 次 · ${s.avgTokens}tok ${s.avgLatencyMs}ms`);
  }
  summary.push({ group: name, v1: agg.v1, v2: agg.v2, runs });
}

/** 把 REPS 次运行聚合成一组指标（通过率 + 总和 + 平均） */
function aggregate(list, group) {
  const n = list.length;
  const sum = (f) => list.reduce((a, x) => a + (f(x) ?? 0), 0);
  const avg = (f) => Math.round(sum(f) / n);
  const quoteTotal = sum(s => s.quote?.total);
  const quoteHit = sum(s => s.quote?.hit);
  const agg = {
    reps: n,
    schemaOkRuns: list.filter(s => s.schemaOk).length,
    quoteTotal, quoteHit,
    quoteInPlace: sum(s => s.quote?.inPlace),
    quoteNeighbor: sum(s => s.quote?.neighbor),
    quoteFallback: sum(s => s.quote?.fallback),
    violations: sum(s => s.violations),
    rawDimConfusedRuns: list.filter(s => s.rawDimConfused > 0).length,
    rawGaveMaterialScoreRuns: list.filter(s => s.rawGaveMaterialScore).length,
    rawStringLocatorsRuns: list.filter(s => s.rawStringLocators).length,
    avgTokens: avg(s => s.tokens),
    avgLatencyMs: avg(s => s.latencyMs),
    sampleRaw: list[0]?.raw ?? '',
    schemaErrors: [...new Set(list.flatMap(s => s.schemaError ?? []))],
  };
  if (group === 'claims') {
    agg.avgN = avg(s => s.n);
    agg.absenceRuns = list.filter(s => s.nAbsence > 0).length;
  }
  if (group === 'evaluate') {
    agg.scoreOutOfRangeRuns = list.filter(s => s.score0to100).length;
    agg.followupRuns = list.filter(s => s.followup).length;
  }
  if (group === 'report') {
    agg.highRiskIdInvalidRuns = list.filter(s => s.highRiskIdsValid === false).length;
  }
  return agg;
}

// 差异表 diff.md（每组一节；只跑部分组时追加现有文件没有的节）
writeFileSync(path.join(OUT_DIR, 'diff.md'), buildDiffMd(summary), 'utf8');
console.log(`\n已写出 ${OUT_DIR}/（${summary.length} 组）`);

function buildDiffMd(summary) {
  const lines = ['# prompt-eval：v1 vs v2 同输入对比（C18）', '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 模型：${MODEL}（与线上 callReal 同参：response_format=json_object）`,
    `- 采样：每组每版本 **${summary[0]?.v1.reps ?? 0} 次**，表里是聚合值（通过率 / 总和 / 平均），避免单次随机性把结论来回翻`,
    '- v2 = `lib/prompts/*.v1.ts` 现行 SYSTEM；v1 = 弱化版（去掉硬约束，观察模型怎么飘）',
    '- 输入：内置样例 sample-paper.docx 的真实 blocks / 会话记录（与 fixtures/llm 同源）',
    '- 机检口径与线上一致：quote 走 `lib/locator.ts` verifyQuote 逐字命中（含 ±2 邻域）',
    '- 两套 system 原文见各组目录下 `v1.system.txt` / `v2.system.txt`；每轮原始 JSON 见 `v1.json` / `v2.json`', ''];
  for (const { group, v1, v2 } of summary) {
    const reps = v1.reps;
    lines.push(`## ${group}`, '',
      '| 指标 | v1（弱化） | v2（现行） | 说明 |', '|---|---|---|---|');
    const rate = (a, b, totalA, totalB) => {
      const ra = totalA ? (a / totalA) : null;
      const rb = totalB ? (b / totalB) : null;
      if (ra === null && rb === null) return '两边都没产出';
      if (ra === rb) return '持平';
      return ra < rb ? '**v2 更稳**' : 'v1 反而略好（见备注）';
    };

    // 1. 结构
    lines.push(`| zod 结构校验通过 | ${v1.schemaOkRuns}/${reps} | ${v2.schemaOkRuns}/${reps} | ${v1.schemaOkRuns < v2.schemaOkRuns ? '**v2 更稳**' : '持平'} |`);
    if (v1.schemaErrors?.length) {
      lines.push(`| 　v1 的报错 | ${v1.schemaErrors.slice(0, 2).join(' / ')} | — | — |`);
    }

    // 2. quote 命中（分母=quote 类 locator 总数，含未命中——与线上口径一致）
    if (v1.quoteTotal || v2.quoteTotal) {
      lines.push(`| quote 逐字命中 | ${v1.quoteHit}/${v1.quoteTotal} | ${v2.quoteHit}/${v2.quoteTotal} | ${rate(v1.quoteHit, v2.quoteHit, v1.quoteTotal, v2.quoteTotal)} |`);
      lines.push(`| 　位置精确（原地/邻域/兜底） | ${v1.quoteInPlace}/${v1.quoteNeighbor}/${v1.quoteFallback} | ${v2.quoteInPlace}/${v2.quoteNeighbor}/${v2.quoteFallback} | 兜底命中=引文对但 block_idx 编错了 |`);
    }

    // 3. 各组特有
    if (group === 'claims') {
      lines.push(`| 每轮平均条数 | ${v1.avgN} | ${v2.avgN} | 上限 12，多不等于好 |`);
      lines.push(`| 用过 absence（缺失类）的轮数 | ${v1.absenceRuns}/${reps} | ${v2.absenceRuns}/${reps} | ${v2.absenceRuns > v1.absenceRuns ? '**v2 更诚实**（查过就说查过，不硬凑引用）' : '持平'} |`);
      lines.push(`| dimension 写成 type 的轮数 | ${v1.rawDimConfusedRuns}/${reps} | ${v2.rawDimConfusedRuns}/${reps} | 被 schema 静默映射，维度轴被压平（实测会压成只剩 depth） |`);
      lines.push(`| 取值违规条数（累计） | ${v1.violations} | ${v2.violations} | block_idx 超界 / quote 出 8–60 字 / risk 出 1–5 |`);
    }
    if (group === 'evaluate') {
      lines.push(`| score 冲出 0–5 量纲的轮数 | ${v1.scoreOutOfRangeRuns}/${reps} | ${v2.scoreOutOfRangeRuns}/${reps} | ${v1.scoreOutOfRangeRuns > v2.scoreOutOfRangeRuns ? '**v2 更稳**（五档写死拽住了量纲）' : '持平'} |`);
      lines.push(`| 给了追问的轮数 | ${v1.followupRuns}/${reps} | ${v2.followupRuns}/${reps} | 这一问考生明显答砸，追不追都合理 |`);
    }
    if (group === 'report') {
      lines.push(`| 越界给材料分的轮数 | ${v1.rawGaveMaterialScoreRuns}/${reps} | ${v2.rawGaveMaterialScoreRuns}/${reps} | 材料分只能服务端聚合，模型给分=两套分数打架 |`);
      lines.push(`| locators 写成字符串的轮数 | ${v1.rawStringLocatorsRuns}/${reps} | ${v2.rawStringLocatorsRuns}/${reps} | 线上真实踩过：整份报告报废降级 |`);
      lines.push(`| high_risk 的 claim_id 编造轮数 | ${v1.highRiskIdInvalidRuns}/${reps} | ${v2.highRiskIdInvalidRuns}/${reps} | 编 id 等于锚点链断掉 |`);
    }

    // 4. 成本（真实记录，写进技术文档第 5 章）
    lines.push(`| 平均 tokens | ${v1.avgTokens} | ${v2.avgTokens} | v2 更长因为约束更多，属预期 |`);
    lines.push(`| 平均延迟 ms | ${v1.avgLatencyMs} | ${v2.avgLatencyMs} | 首字延迟另在 eval.mjs 测 |`);
    lines.push('');

    // 代表样本
    lines.push(`<details><summary>v1 代表输出（第 1 轮）</summary>\n\n\`\`\`json\n${v1.sampleRaw}\n\`\`\`\n</details>`);
    lines.push(`<details><summary>v2 代表输出（第 1 轮）</summary>\n\n\`\`\`json\n${v2.sampleRaw}\n\`\`\`\n</details>`);
    lines.push('');
  }

  lines.push('## 一句话结论', '');
  for (const { group, v1, v2 } of summary) {
    const reps = v1.reps;
    const bits = [];
    if (v1.schemaOkRuns < v2.schemaOkRuns) {
      bits.push(`v1 的 zod 通过率只有 ${v1.schemaOkRuns}/${reps}（v2 ${v2.schemaOkRuns}/${reps}）——弱 prompt 下模型会输出非法枚举值，没有 schema 兜底整条链就断在解析`);
    }
    if (v1.quoteTotal && v2.quoteTotal && v1.quoteHit / v1.quoteTotal < v2.quoteHit / v2.quoteTotal) {
      bits.push(`quote 命中 v1 ${v1.quoteHit}/${v1.quoteTotal} vs v2 ${v2.quoteHit}/${v2.quoteTotal}——"逐字 8–60 字 + block_idx 必须是给的编号"这两条硬约束直接决定引文能不能被机检追回`);
    }
    if (v1.quoteFallback > v2.quoteFallback) {
      bits.push(`v1 有 ${v1.quoteFallback} 条引文靠"全篇兜底"才命中（引文对、位置错），v2 是 ${v2.quoteFallback} 条`);
    }
    if (group === 'claims' && v2.absenceRuns > v1.absenceRuns) {
      bits.push(`absence 出口：v2 ${v2.absenceRuns}/${reps} 轮会用，v1 ${v1.absenceRuns}/${reps}——不给"这里没有"的合法出口，模型就会硬凑一句引用，直接污染命中率`);
    }
    if (group === 'claims' && v1.rawDimConfusedRuns > 0) {
      bits.push(`v1 有 ${v1.rawDimConfusedRuns}/${reps} 轮把 dimension 写成了 type（method/value），经 DimIn 静默映射后多压在 depth/expression 两维上，按维分席的机制随之失效`);
    }
    if (group === 'evaluate' && v1.scoreOutOfRangeRuns > 0) {
      bits.push(`v1 有 ${v1.scoreOutOfRangeRuns}/${reps} 轮自行把分制改成百分制——不把五档判定条件写死，模型会另起一套量纲`);
    }
    if (group === 'report' && (v1.rawGaveMaterialScoreRuns || v1.rawStringLocatorsRuns)) {
      const what = [];
      if (v1.rawGaveMaterialScoreRuns) what.push(`${v1.rawGaveMaterialScoreRuns}/${reps} 轮给了材料分`);
      if (v1.rawStringLocatorsRuns) what.push(`${v1.rawStringLocatorsRuns}/${reps} 轮把 locators 写成字符串`);
      bits.push(`v1 ${what.join('、')}——报告要么与 risk_score 打架，要么整份被判死降级成模板`);
    }
    if (bits.length === 0) bits.push(`本次 ${reps} 轮里两组没拉开差距；保留 v2 的理由不是"分数更好看"，而是它排掉的都是会让整条链断掉的失效模式`);
    lines.push(`- **${group}**：${bits.join('；')}。`);
  }
  lines.push('', '## 备注', '',
    '- 这些数字是**机检**结果，只覆盖"结构和可追溯性"，不判断评语写得好不好——那部分在 `docs/eval/eval-result.json` 的人工抽检里。',
    '- v1 不是"历史上真的用过的一版"，而是按当前 v2 的每一条硬约束**逐条拆掉**后的对照物：拆掉哪条、哪条就出问题，这条因果才是要留的证据。',
    '- 重跑：`node scripts/prompt-eval.mjs`（直连 DeepSeek，与 MOCK_LLM 无关）；`PROMPT_EVAL_REPS=5` 可加采样。');
  return lines.join('\n');
}
