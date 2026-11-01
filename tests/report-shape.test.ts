import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportOut, ReportLocatorIn, LocatorOut, EvaluateOut } from '../lib/schemas.ts';
import { attachReportLocator } from '../lib/locator.ts';
import { REPORT_SYSTEM } from '../lib/prompts/report.v1.ts';
import type { Block } from '../lib/parse.ts';

/**
 * 报告形状的两条真实缺陷回归（2026-11-01 真实 key 实测暴露）
 *
 * 【事故事实】
 * 跑 POST /end 时报告模型返回了一份**质量很高**的输出（四维评语、8 条高风险清单、advice 全齐），
 * 但 locators 写成了纯字符串数组：
 *   "locators": ["我们认为该结论可以推广到全市乃至全省的课后服务管理场景"]
 * 约定是 `[{kind, block_idx, quote}]` → zod 校验失败 → 整份报告降级成模板。
 * 用户拿到的是一份"没有模型评语"的报告，而我们丢掉的那份其实很好。
 *
 * 【两条修法的边界很关键】
 *   · prompt 侧：把对象形状写出来（原来是"格式与判分时一致"这种自述式说明）
 *   · schema 侧：允许字符串，规整成 {quote}，位置标 -1 → 机检判**未校验**，
 *     **绝不能被当成"合法出处"**。容错与编数据的界线就在这里。
 */

function blocks(): Block[] {
  return [
    { idx: 0, page: 1, section: '摘要', text: '我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。' },
    { idx: 1, page: 1, section: '摘要', text: '模型的决定系数为 0.62，说明三类字段能解释大部分满意度差异。' },
  ];
}

// ─────────────────────────── schema 容错 ───────────────────────────

test('ReportOut：locators 写成纯字符串数组时**不整份报废**（真实事故回归）', () => {
  const r = ReportOut.safeParse({
    material_risk: [
      {
        dimension: 'logic',
        comment: '从三所小学的相关性结果直接跳到全省推广，中间缺代表性论证。',
        locators: ['我们认为该结论可以推广到全市乃至全省的课后服务管理场景'],
      },
    ],
    performance: [{ dimension: 'logic', score: 30, comment: '答非所问' }],
    high_risk: [],
    advice: '把相关说成预测、把三校说成全省，这类表述会被逐句拆。',
  });
  assert.equal(r.success, true, '一句字符串不该让整份报告消失');
  if (r.success) {
    // 规整后的 quote 就是那句原文，位置为 -1（未知）
    assert.equal(r.data.material_risk[0].locators[0].quote, '我们认为该结论可以推广到全市乃至全省的课后服务管理场景');
    assert.equal(r.data.material_risk[0].locators[0].block_idx, -1, '位置未知时显式标 -1，不许猜一个块号');
  }
});

test('ReportLocatorIn：字符串被规整为 quote 类，且 kind 有默认值', () => {
  const r = ReportLocatorIn.safeParse('模型只给了一句引文没给位置');
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal(r.data.kind, 'quote');
    assert.equal(r.data.block_idx, -1);
  }
});

test('ReportLocatorIn：正常的对象形状仍然照常通过（容错不影响正确路径）', () => {
  const r = ReportLocatorIn.safeParse({ kind: 'quote', block_idx: 3, quote: '模型的决定系数为 0.62' });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.block_idx, 3);
});

test('ReportLocatorIn：absence 对象仍然要求 scope（容错不放松真校验）', () => {
  const r = ReportLocatorIn.safeParse({ kind: 'absence', block_idx: 2, quote: '' });
  assert.equal(r.success, false, 'absence 缺 scope 仍然是错');
});

test('ReportLocatorIn：quote 过短的字符串仍然被拒（不把废话当引用）', () => {
  const r = ReportLocatorIn.safeParse('太短');
  assert.equal(r.success, false);
});

test('LocatorOut（判分用）仍然是严格版：不接受字符串', () => {
  // 【为什么这条要测】判分那条链路一次只评一条回答，容错空间大、也更该严。
 // 只有报告因为是"一次性产出整份"才值得放宽。两条链路的严格度不同是刻意的。
  const r = LocatorOut.safeParse('一句字符串');
  assert.equal(r.success, false, '判分链路不该接受字符串形式的 locator');
});

// ─────────────────────────── 机检：位置缺失要标未校验 ───────────────────────────

test('attachReportLocator：位置缺失（-1）时**保留 quote**、标 verified=0', () => {
  const { locator, verified, reason } = attachReportLocator(blocks(), {
    kind: 'quote',
    block_idx: -1,
    quote: '我们认为该结论可以推广到全市乃至全省的课后服务管理场景',
  });
  assert.ok(locator, '内容必须保留——用户要看得到模型指着哪句话');
  assert.equal(verified, 0, '位置没给 = 无法逐字核对 = 未校验（绝不能算通过）');
  assert.equal(locator!.blockIdx, -1, '位置显式 -1，前端据此不显示可点标签');
  assert.match(reason || '', /未给出 block_idx|位置未标注/);
});

test('attachReportLocator：越界位置（99）也保留 quote、标 verified=0', () => {
  const { locator, verified } = attachReportLocator(blocks(), {
    kind: 'quote',
    block_idx: 99,
    quote: '模型的决定系数为 0.62，说明三类字段能解释',
  });
  assert.ok(locator);
  assert.equal(verified, 0);
  assert.match(locator!.quote, /0.62/);
});

test('attachReportLocator：位置合法时正常机检（命中=1）', () => {
  const { locator, verified, reason } = attachReportLocator(blocks(), {
    kind: 'quote',
    block_idx: 1,
    quote: '模型的决定系数为 0.62',
  });
  assert.equal(verified, 1);
  assert.equal(locator!.page, 1);
  assert.match(reason || '', /命中/);
});

test('attachReportLocator：位置合法但引文不存在 → verified=0（不隐藏失败）', () => {
  const { locator, verified } = attachReportLocator(blocks(), {
    kind: 'quote',
    block_idx: 0,
    quote: '这句话原文里根本没有出现过哦',
  });
  assert.ok(locator, '未命中也保留，进分母');
  assert.equal(verified, 0);
});

test('attachReportLocator：absence 位置缺失时如实丢弃（没有内容可留）', () => {
  const { locator } = attachReportLocator(blocks(), { kind: 'absence', block_idx: -1, scope: '第三章' });
  assert.equal(locator, null, 'absence 没有 quote 可留，丢掉是对的');
});

test('attachReportLocator：位置缺失且 quote 过短 → 丢弃（不把"太短"当引用）', () => {
  const { locator } = attachReportLocator(blocks(), { kind: 'quote', block_idx: -1, quote: '太短' });
  assert.equal(locator, null);
});

// ─────────────────────────── 数组超限容错（第二个真实事故） ───────────────────────────

test('ReportOut：material_risk 给 5 条（某维写两遍）→ 按维度去重，不整份报废', () => {
  // 【第二个真实事故，2026-11-01】模型给了 5 条 material_risk：某个维度写了两遍。
  // .max(4) 直接判整份失败 → 报告又降级成模板。第二轮实测在同一处再挂一次。
  const r = ReportOut.safeParse({
    material_risk: [
      { dimension: 'logic', comment: '短评语', locators: [] },
      { dimension: 'evidence', comment: '证据维度的一条评语写得很具体，交代了抽样与验证的缺口。', locators: [] },
      { dimension: 'logic', comment: '逻辑维度的第二条评语，比第一条更具体地说明了外推的问题所在。', locators: [] },
      { dimension: 'depth', comment: '技术深度评语', locators: [] },
      { dimension: 'expression', comment: '表达评语', locators: [] },
    ],
    performance: [{ dimension: 'logic', score: 30, comment: '答非所问' }],
    high_risk: [],
    advice: '统一降级措辞。',
  });
  assert.equal(r.success, true, '一个维度写两遍不该让整份报告报废');
  if (r.success) {
    assert.equal(r.data.material_risk.length, 4, '去重后恰好 4 维');
    // 逻辑维应保留**评语更长**的那条（信息量更大），而不是第一条
    const logic = r.data.material_risk.find((m) => m.dimension === 'logic')!;
    assert.equal(logic.comment, '逻辑维度的第二条评语，比第一条更具体地说明了外推的问题所在。');
  }
});

test('ReportOut：performance 某维写两遍 → 按维度去重，保留更保守（更低）的分', () => {
  const r = ReportOut.safeParse({
    material_risk: [],
    performance: [
      { dimension: 'logic', score: 60, comment: '第一版' },
      { dimension: 'logic', score: 30, comment: '第二版' },
      { dimension: 'evidence', score: 35, comment: '证据' },
    ],
    high_risk: [],
    advice: 'x',
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal(r.data.performance.length, 2, '去重后 2 维');
    assert.equal(r.data.performance.find((p) => p.dimension === 'logic')!.score, 30, '取更保守的分，不美化');
  }
});

test('ReportOut：high_risk 给 10 条 → 截断到 8（"前 N 条"本来就是截断语义）', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    claim_id: `c${i}`,
    question: `第 ${i} 个可能被问的问题`,
    why: `为什么第 ${i} 条会崩`,
    suggestion: `第 ${i} 条怎么改材料`,
  }));
  const r = ReportOut.safeParse({
    material_risk: [],
    performance: [],
    high_risk: many,
    advice: 'x',
  });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.high_risk.length, 8, '业务口径是最多 8 条');
});

test('EvaluateOut：gaps 给 5 条 → 截断到 4，判分不因多一条缺口而报废', () => {
  const r = EvaluateOut.safeParse({
    score: 2,
    gaps: ['a1', 'b2', 'c3', 'd4', 'e5'],
    locators: [{ kind: 'quote', block_idx: 1, quote: '模型的决定系数为 0.62' }],
    followup: null,
  });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.gaps.length, 4);
});

test('EvaluateOut：locators 给 5 条 → 截断到 4；但 min(1) 不许放松', () => {
  const five = Array.from({ length: 5 }, (_, i) => ({
    kind: 'quote' as const,
    block_idx: i,
    quote: '模型的决定系数为 0.62',
  }));
  const r = EvaluateOut.safeParse({ score: 3, gaps: [], locators: five, followup: null });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.locators.length, 4);

  // 但"一条出处都没有"仍然必须失败：那是 anchor-verified 的硬承诺
  const none = EvaluateOut.safeParse({ score: 3, gaps: [], locators: [], followup: null });
  assert.equal(none.success, false, '每条评价 ≥1 条出处不许放松');
});

test('报告 prompt 里必须写明 locator 的对象形状（含 block_idx 必给）', () => {
  // 【为什么单测 prompt 文本】这次事故的本质是 prompt 写得太笼统：
  // 原文只有"格式与判分时一致"，模型没被告知要给 block_idx，于是给了纯字符串。
  // 笼统的格式说明在多段式 prompt 里就是会失效——所以形状必须逐字段写出来。
  assert.match(REPORT_SYSTEM, /block_idx/, '必须点名 block_idx');
  assert.match(REPORT_SYSTEM, /必须给/, '必须说"必须给"，不能只说"可以"');
  assert.match(REPORT_SYSTEM, /\{"kind":"quote"/, '必须给出可照抄的对象样例');
  assert.match(REPORT_SYSTEM, /反例/, '必须写出反例（模型对反例的敏感度高于规则）');
});

test('报告 prompt 里必须明确禁止给材料维度打分（模型最爱越界的一处）', () => {
  assert.match(REPORT_SYSTEM, /不许输出 score/, '必须明写不许给分');
  assert.match(REPORT_SYSTEM, /material_risk[^]*没有 score|不许给分/, '要点明 material_risk 没有分数字段');
});

test('报告 prompt 里必须写明 performance 的极性（越大越好）', () => {
  // material_risk 越大越糟、performance 越大越好，极性搞反的分数会直接误导用户
  assert.match(REPORT_SYSTEM, /越大越好/);
});

test('报告 prompt 里必须写明 high_risk 的 claim_id 只能从清单复制', () => {
  assert.match(REPORT_SYSTEM, /claim_id/);
  assert.match(REPORT_SYSTEM, /原样复制|不许编/);
});
