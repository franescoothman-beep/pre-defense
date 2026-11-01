import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  aggregateMaterialRisk,
  boardOf,
  claimDiffOf,
  computeDelta,
  deltaFor,
  overallOfCells,
  overallScoreOf,
  parsePerformanceRows,
  parseRiskCells,
  CLAIM_TYPE_ORDER,
  CLAIM_TYPE_LABEL,
  type ClaimBrief,
  type ClaimRow,
  type RiskCell,
} from '../lib/report.ts';

/**
 * 阶段 5 的报告契约：看板 / 二练对比 / 双口径总分。
 *
 * 【这一组测的不是"能不能跑"，而是三条会悄悄撒谎的地方】
 *   ① drill 报告里冒出风险分差 —— 材料一个字没改，那个差恒等于 0，
 *      屏幕上写 "−0" 会被读成"系统坏了"。C17 明令禁止。
 *   ② 看板格子与左栏大数字各算各的 —— 评委拿 claims 一复算就对不上，
 *      整个"可复现"的立论就塌了。
 *   ③ 两场之间全部无变化时被渲染成"0 改善" —— 真相是"这一次没法比"。
 */

const ROOT = process.cwd();
const reportSrc = fs.readFileSync(path.join(ROOT, 'app', 'report', '[id]', 'page.tsx'), 'utf8');
const reportCss = fs.readFileSync(path.join(ROOT, 'app', 'report', '[id]', 'report.css'), 'utf8');
const endSrc = fs.readFileSync(
  path.join(ROOT, 'app', 'api', 'sessions', '[id]', 'end', 'route.ts'),
  'utf8',
);
const reportApiSrc = fs.readFileSync(
  path.join(ROOT, 'app', 'api', 'reports', '[id]', 'route.ts'),
  'utf8',
);

// ─────────────────────────── 夹具 ───────────────────────────

let n = 0;
function claim(over: Partial<ClaimRow & { type: string; text: string; quote: string }> = {}) {
  n += 1;
  return {
    id: over.id ?? `c${n}`,
    dimension: over.dimension ?? 'logic',
    risk: over.risk ?? 3,
    verified: over.verified ?? 1,
    locator_kind: over.locator_kind ?? 'quote',
    type: over.type ?? 'method',
    text: over.text ?? `质疑点 ${n}`,
    quote: over.quote ?? `原文引用片段 ${n} 这一段`,
  };
}

function brief(over: Partial<ClaimBrief> = {}): ClaimBrief {
  n += 1;
  return {
    id: over.id ?? `b${n}`,
    dimension: over.dimension ?? 'logic',
    risk: over.risk ?? 3,
    text: over.text ?? `质疑点 ${n}`,
    quote: over.quote ?? `原文引用片段 ${n} 这一段`,
    locator_kind: over.locator_kind ?? 'quote',
    type: over.type ?? 'method',
  };
}

function cells(over: Partial<Record<string, number | null>>): RiskCell[] {
  const dims = ['logic', 'evidence', 'depth', 'expression'] as const;
  return dims.map((dimension) => {
    const score = over[dimension];
    return {
      dimension,
      risk_score: score === undefined ? null : score,
      claims: score === null || score === undefined ? 0 : 1,
      absence: 0,
    };
  });
}

// ─────────────────────────── 双口径总分 ───────────────────────────

test('全场材料风险：按各维质疑点条数加权，不是四个数简单平均', () => {
  const c: RiskCell[] = [
    { dimension: 'logic', risk_score: 80, claims: 3, absence: 0 },
    { dimension: 'evidence', risk_score: 20, claims: 1, absence: 0 },
  ];
  // (80×3 + 20×1) / 4 = 65；简单平均会得 50 —— 那是错的
  assert.equal(overallOfCells(c), 65);
});

test('全场材料风险：缺维（risk_score=null）不进分子也不进分母', () => {
  const c: RiskCell[] = [
    { dimension: 'logic', risk_score: 60, claims: 2, absence: 0 },
    { dimension: 'evidence', risk_score: null, claims: 0, absence: 0 },
  ];
  assert.equal(overallOfCells(c), 60);
});

test('全场材料风险：一维都没有 → null（不是 0，0 会被读成"完全安全"）', () => {
  assert.equal(overallOfCells(cells({})), null);
});

test('全场临场表现：只平均本场真的问到的维度', () => {
  assert.equal(overallScoreOf([{ score: 60 }, { score: null }, { score: 80 }]), 70);
});

test('全场临场表现：一个维度都没问到 → null', () => {
  assert.equal(overallScoreOf([{ score: null }, { score: null }]), null);
});

// ─────────────────────────── 二练对比：C17 铁律 ───────────────────────────

test('drill：只比临场表现，绝不出现风险分差（C17）', () => {
  const prev = cells({ logic: 90, evidence: 90 });
  const now = cells({ logic: 10, evidence: 10 }); // 风险差得天差地别
  const d = computeDelta(
    'drill',
    prev,
    now,
    [{ dimension: 'logic', score: 40 }],
    [{ dimension: 'logic', score: 70 }],
  );
  assert.deepEqual(d.risk, [], 'drill 的 risk 必须恒为空数组');
  assert.equal(d.perf.length, 1);
  assert.equal(d.perf[0].prev, 40);
  assert.equal(d.perf[0].now, 70);
});

test('revise：只比材料风险，绝不出现表现分差（C17 的另一半）', () => {
  const d = computeDelta(
    'revise',
    cells({ logic: 70 }),
    cells({ logic: 40 }),
    [{ dimension: 'logic', score: 40 }],
    [{ dimension: 'logic', score: 90 }],
  );
  assert.deepEqual(d.perf, [], 'revise 的 perf 必须恒为空数组');
  assert.equal(d.risk.length, 1);
  assert.equal(d.risk[0].prev, 70);
  assert.equal(d.risk[0].now, 40);
});

test('分数没变 → 不进对比行（不出现 "−0"）', () => {
  const d = computeDelta(
    'drill',
    cells({}),
    cells({}),
    [{ dimension: 'logic', score: 60 }],
    [{ dimension: 'logic', score: 60 }],
  );
  assert.deepEqual(d.perf, [], 'diff===0 必须被跳过，而不是输出 0');
});

test('一侧缺分 → 不进对比行（宁可少比一维，不拿 null 当 0）', () => {
  const d = computeDelta(
    'drill',
    cells({}),
    cells({}),
    [{ dimension: 'logic', score: 60 }],
    [{ dimension: 'logic', score: null }],
  );
  assert.deepEqual(d.perf, []);
});

test('deltaFor：没有上一场报告 → null（如实说"没法比"）', () => {
  assert.equal(
    deltaFor({ kind: 'revise', prevReport: null, nowRisk: cells({ logic: 50 }), nowPerf: [] }),
    null,
  );
});

test('deltaFor：上一份报告结构坏掉 → null，不抛异常', () => {
  assert.equal(
    deltaFor({
      kind: 'revise',
      prevReport: { material_risk: '这不是 JSON', performance: 42 },
      nowRisk: cells({ logic: 50 }),
      nowPerf: [],
    }),
    null,
  );
});

test('deltaFor：revise 挂上质疑点增删；drill 不挂', () => {
  const prevReport = { material_risk: cells({ logic: 70 }), performance: [] };
  const revise = deltaFor({
    kind: 'revise',
    prevReport,
    nowRisk: cells({ logic: 40 }),
    nowPerf: [],
    prevClaims: [brief({ text: '结论缺对照组' })],
    nowClaims: [brief({ text: '结论缺对照组' })],
  });
  assert.ok(revise?.claims, 'revise 必须带 claim 增删');
  assert.equal(revise.claims.prevTotal, 1);
  assert.equal(revise.claims.kept, 1);

  const drill = deltaFor({
    kind: 'drill',
    prevReport,
    nowRisk: cells({ logic: 40 }),
    nowPerf: [{ dimension: 'logic', score: 70 }],
    prevClaims: [brief()],
    nowClaims: [brief()],
  });
  assert.equal(drill?.claims, undefined, 'drill 不比较材料，不该出现 claim 增删');
});

test('parseRiskCells：接受数组与 JSON 字符串两种落库形态', () => {
  const arr = cells({ logic: 55 });
  assert.ok(parseRiskCells(arr));
  assert.ok(parseRiskCells(JSON.stringify(arr)));
  assert.equal(parseRiskCells('{"nope":1}'), null);
  assert.equal(parseRiskCells(null), null);
});

test('parsePerformanceRows：接受数组与 JSON 字符串', () => {
  const rows = [{ dimension: 'logic', score: 70 }];
  assert.deepEqual(parsePerformanceRows(rows), rows);
  assert.deepEqual(parsePerformanceRows(JSON.stringify(rows)), rows);
  assert.equal(parsePerformanceRows('坏数据'), null);
});

// ─────────────────────────── 质疑点增删 ───────────────────────────

test('claimDiffOf：标点/空白不同视为同一条（模型两次措辞会抖）', () => {
  const prev = [brief({ id: 'p1', text: '缺少对照组，结论不成立' })];
  const now = [brief({ id: 'n1', text: '缺少对照组, 结论不成立。' })];
  const d = claimDiffOf(prev, now);
  assert.equal(d.kept, 1);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});

test('claimDiffOf：同一句原文下换了质疑措辞，也算同一条（按 quote 兜底）', () => {
  const prev = [brief({ id: 'p1', text: '第一版说法', quote: '这句话原文里确实存在并且足够长' })];
  const now = [brief({ id: 'n1', text: '完全不同的措辞', quote: '这句话原文里确实存在并且足够长' })];
  const d = claimDiffOf(prev, now);
  assert.equal(d.kept, 1);
});

test('claimDiffOf：改材料后消失 / 新出现', () => {
  const prev = [brief({ id: 'p1', text: 'A 质疑' }), brief({ id: 'p2', text: 'B 质疑' })];
  const now = [brief({ id: 'n1', text: 'A 质疑' }), brief({ id: 'n2', text: 'C 质疑' })];
  const d = claimDiffOf(prev, now);
  assert.equal(d.prevTotal, 2);
  assert.equal(d.nowTotal, 2);
  assert.equal(d.kept, 1);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].text, 'C 质疑');
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].text, 'B 质疑');
});

test('claimDiffOf：风险打分变了要单列（下调=改好了）', () => {
  const prev = [brief({ id: 'p1', text: '同一个质疑点', risk: 5 })];
  const now = [brief({ id: 'n1', text: '同一个质疑点', risk: 2 })];
  const d = claimDiffOf(prev, now);
  assert.equal(d.riskDown.length, 1);
  assert.equal(d.riskDown[0].prevRisk, 5);
  assert.equal(d.riskDown[0].nowRisk, 2);
  assert.equal(d.riskUp.length, 0);
});

test('claimDiffOf：absence 补上原文 / 反而引不出原文，都要计数', () => {
  const prev = [brief({ id: 'p1', text: 'X 缺证据', locator_kind: 'absence' })];
  const now = [brief({ id: 'n1', text: 'X 缺证据', locator_kind: 'quote' })];
  assert.equal(claimDiffOf(prev, now).absenceFilled, 1);
  assert.equal(claimDiffOf(now, prev).absenceIntroduced, 1);
});

test('claimDiffOf：列表按风险降序截断，最多 5 条（页面不适合长清单）', () => {
  const prev = Array.from({ length: 9 }, (_, i) =>
    brief({ id: `p${i}`, text: `旧质疑 ${i}`, risk: (i % 5) + 1 }),
  );
  const d = claimDiffOf(prev, []);
  assert.equal(d.removed.length, 5);
  const risks = d.removed.map((r) => r.risk);
  assert.deepEqual(risks, [...risks].sort((a, b) => b - a), '必须按风险从高到低');
});

// ─────────────────────────── 质询风险看板 ───────────────────────────

test('看板：永远三行（方法论 / 工程实现 / 价值与创新），每行四格', () => {
  const rows = boardOf([], [], new Set());
  assert.deepEqual(
    rows.map((r) => r.type),
    [...CLAIM_TYPE_ORDER],
    '行顺序必须固定，否则每次刷新行头都换位置',
  );
  for (const r of rows) {
    assert.equal(r.cells.length, 4, '每行必须是四个维度格');
    assert.equal(r.label, CLAIM_TYPE_LABEL[r.type]);
  }
});

test('看板：材料里没有的格子 count=0 且 risk=null（不是 0 分）', () => {
  const rows = boardOf([claim({ type: 'method', dimension: 'logic' })], [], new Set());
  const logic = rows[0].cells.find((c) => c.dimension === 'logic')!;
  const depth = rows[0].cells.find((c) => c.dimension === 'depth')!;
  assert.equal(logic.count, 1);
  assert.equal(depth.count, 0);
  assert.equal(depth.risk_score, null, '空格必须是 null，0 会被读成"很安全"');
});

test('看板格子与左栏大数字同源：能拿 claims 当场复算', () => {
  const claims = [
    claim({ type: 'method', dimension: 'logic', risk: 5 }),
    claim({ type: 'method', dimension: 'logic', risk: 1 }),
  ];
  const rows = boardOf(claims, [], new Set());
  const cell = rows[0].cells.find((c) => c.dimension === 'logic')!;
  const independent = aggregateMaterialRisk(claims).find((c) => c.dimension === 'logic')!;
  assert.equal(cell.risk_score, independent.risk_score, '两处算法必须是同一个');
  // risk 5 → 100，risk 1 → 0，等权 → 50
  assert.equal(cell.risk_score, 50);
});

test('看板：行总数 = 四个格子之和', () => {
  const claims = [
    claim({ type: 'value', dimension: 'logic' }),
    claim({ type: 'value', dimension: 'logic' }),
    claim({ type: 'value', dimension: 'expression' }),
  ];
  const rows = boardOf(claims, [], new Set());
  const row = rows.find((r) => r.type === 'value')!;
  assert.equal(row.total, 3);
  assert.equal(
    row.cells.reduce((s, c) => s + c.count, 0),
    3,
  );
});

test('看板：行头标出占席评委；无此席位时为 null（不编一个名字）', () => {
  const rows = boardOf(
    [claim({ type: 'method' })],
    [{ id: 'p1', name: '林晖', role: 'method' }],
    new Set(),
  );
  assert.equal(rows[0].judgeName, '林晖');
  assert.equal(rows[0].cells[0].asked, 0, '本场没问过 = 0');
  assert.equal(rows[1].judgeName, null, '材料缺这类质疑时没有评委席位');
});

test('看板：两位评委同为 method 也不会出现两行一样的数字', () => {
  // planSeats 在材料维度不足时允许同维度补位，于是可能两个席位都是 method。
  // 若按评委分行，这里会得到两行完全相同的格子 —— 读起来像"数据出错了"。
  const claims = [claim({ type: 'method', dimension: 'logic', risk: 4 })];
  const rows = boardOf(
    claims,
    [
      { id: 'p1', name: 'A', role: 'method' },
      { id: 'p2', name: 'B', role: 'method' },
    ],
    new Set(),
  );
  assert.equal(rows.length, 3, '行数只跟质疑类型有关');
  const methodRows = rows.filter((r) => r.type === 'method');
  assert.equal(methodRows.length, 1, '不允许同一类质疑出现两行');
});

test('看板：asked 只数本场真的问到的那几条', () => {
  const a = claim({ id: 'a', type: 'method', dimension: 'logic' });
  const b = claim({ id: 'b', type: 'method', dimension: 'logic' });
  const rows = boardOf([a, b], [], new Set(['a']));
  const cell = rows[0].cells.find((c) => c.dimension === 'logic')!;
  assert.equal(cell.count, 2);
  assert.equal(cell.asked, 1);
});

// ─────────────────────────── 服务端接线 ───────────────────────────

test('出报告时算完 delta 就落库（读接口现算会因重抽 claims 而改数字）', () => {
  assert.match(endSrc, /deltaFor\(/, '必须调用 deltaFor');
  assert.match(endSrc, /JSON\.stringify\(delta\)/, 'delta 必须序列化落库');
  assert.match(endSrc, /prev_session_id/, '上一场会话 id 要落库，读接口才知道跟谁比');
});

test('报告接口把看板与两种总分一起带出来', () => {
  assert.match(reportApiSrc, /boardOf\(/, '看板在服务端算');
  assert.match(reportApiSrc, /overallRisk/, '材料风险总分');
  assert.match(reportApiSrc, /overallPerf/, '临场表现总分');
  assert.match(reportApiSrc, /mock:/, 'MOCK 事实要带给客户端页');
});

// ─────────────────────────── 页面契约 ───────────────────────────

test('看板格子可点击跳转到该 (维度,类型) 的质疑点清单', () => {
  assert.match(reportSrc, /className="board-cell"/, '格子必须是链接');
  assert.match(reportSrc, /\/doc\/\$\{[^}]*docId[^}]*\}\?dim=/, '跳转要带文档 id 与维度');
  assert.match(reportSrc, /type=\$\{row\.type\}/, '跳转要带质疑类型');
});

test('看板空格子不做成可点（点进去只会看到空列表）', () => {
  assert.match(reportSrc, /cell\.count === 0/, '空格必须分支处理');
  assert.match(reportSrc, /className="cell-empty"/);
});

test('报告页：drill 明说"材料没改，所以风险分不会变"', () => {
  assert.match(reportSrc, /材料一个字没改/, 'drill 必须自证为什么没有风险分差');
});

test('报告页：两类对比按 kind 分叉，不合成一张"统一差值表"', () => {
  assert.match(reportSrc, /delta\.kind === 'revise'|const isRevise = delta\.kind === 'revise'/);
  // revise：风险下降是好事；drill：表现上升是好事
  assert.match(reportSrc, /isRevise \? diff < 0 : diff > 0/);
});

test('报告页：两场都无可比项时说的是"没法比"，不是"没改善"', () => {
  assert.match(reportSrc, /这一次没法比/);
});

test('报告页：两条复练路径都真的接了接口', () => {
  assert.match(reportSrc, /mode: 'drill', drillFrom: ctx\.sessionId/, 'drill 必须新建一场并指回本场');
  assert.match(reportSrc, /\/upload\?revise=/, 'revise 走上传改后材料');
});

test('报告页：MOCK 角标（回放数据必须当场说明）', () => {
  assert.match(reportSrc, /report-foot/);
  assert.match(reportSrc, /MOCK 演示模式/);
});

test('报告页：空态与错误态各有明确出口', () => {
  assert.match(reportSrc, /这份报告没有数据/);
  assert.match(reportSrc, /结束并出报告/, '错误态要告诉用户怎么才能有报告');
});

test('报告页：绝不 dangerouslySetInnerHTML（S3）', () => {
  // 【为什么要先剥注释】这一页的注释里就写着这条禁令本身
  // （"所有模型输出按纯文本渲染，绝不 dangerouslySetInnerHTML"）。
  // 直接全文搜会把"写了禁令的地方"判成"违反禁令的地方"，
  // 结果只能靠删注释来变绿 —— 那是为了让测试通过而破坏文档。
  const codeOnly = reportSrc
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSX 的 {/* */}）
    .replace(/^\s*\/\/.*$/gm, ''); // 整行行注释
  assert.doesNotMatch(codeOnly, /dangerouslySetInnerHTML/);
});

test('报告 CSS：看板/大数字/复练入口的类都在，且颜色全走 token', () => {
  for (const cls of ['.board-t', '.board-cell', '.cellv', '.cellbar', '.big-num', '.delta-row', '.claim-diff', '.act-btn', '.report-foot']) {
    assert.ok(reportCss.includes(cls), `缺样式：${cls}`);
  }
  const hex = reportCss.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(hex, [], `报告 CSS 里出现了十六进制颜色：${hex.join(', ')}`);
});

test('报告 CSS：risk 与 perf 不共用颜色映射（C14）', () => {
  // 左侧高风险用朱红系；右侧好分数用竹青。两个类名必须分开
  assert.match(reportCss, /\.cellv\.is-high\s*\{\s*color: var\(--red\)/);
  assert.match(reportCss, /\.big-num\.is-good\s*\{\s*color: var\(--green\)/);
});
