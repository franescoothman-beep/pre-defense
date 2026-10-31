import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaimsOut, ReportOut, EvaluateOut, PersonasOut } from '../lib/schemas.ts';

test('ClaimsOut：接受合法批次', () => {
  const ok = ClaimsOut.safeParse({
    claims: [{ type: 'method', text: '样本量说明不清', block_idx: 3, kind: 'quote',
      quote: '两人独立标注，不一致由第三人裁决', risk: 4, dimension: 'evidence' }],
  });
  assert.equal(ok.success, true);
});

test('ClaimsOut：quote 长度不在 schema 层裁决，交由 locator 机检（避免整批被拒）', () => {
  const shortQuote = ClaimsOut.safeParse({
    claims: [{ type: 'method', text: '样本量说明不清', block_idx: 1, kind: 'quote', quote: '两人', risk: 3, dimension: 'logic' }],
  });
  assert.equal(shortQuote.success, true, '长度问题在机检时判 verified=0，不该让整批失败');
});

test('ClaimsOut：缺少必填字段 → 拒绝', () => {
  const bad = ClaimsOut.safeParse({ claims: [{ type: 'method', block_idx: 1 }] });
  assert.equal(bad.success, false);
});

test('ClaimsOut：非法枚举 → 拒绝', () => {
  const bad = ClaimsOut.safeParse({
    claims: [{ type: 'unknown_kind', text: 'x', block_idx: 1, risk: 3, dimension: 'logic' }],
  });
  assert.equal(bad.success, false);
});

// ── 真实模型的两个偏差（实测 DeepSeek 给出，见 ai-log 20261031-claims）──

test('ClaimsOut：block_idx 被写成 "[3]" 时规整为数字 3（不整批报废）', () => {
  const r = ClaimsOut.safeParse({
    claims: [{ type: 'method', text: '样本代表性不足', block_idx: '[3]', kind: 'quote',
      quote: '我们采集了某市三所小学一学期的课后服务记录', risk: 4, dimension: 'evidence' }],
  });
  assert.equal(r.success, true, '括号只是排版记号，不该让整批消失');
  if (r.success) assert.equal(r.data.claims[0].block_idx, 3);
});

test('ClaimsOut：block_idx 的其他常见写法也能规整', () => {
  for (const raw of ['3', '（3）', 'block 3', 'BLOCK 12']) {
    const r = ClaimsOut.safeParse({
      claims: [{ type: 'method', text: 'x'.repeat(6), block_idx: raw, kind: 'quote', quote: '一二三四五六七八', risk: 3, dimension: 'logic' }],
    });
    assert.equal(r.success, true, `${raw} 应被接受`);
  }
});

test('ClaimsOut：block_idx 完全无数字 → 仍然拒绝（不编造）', () => {
  const r = ClaimsOut.safeParse({
    claims: [{ type: 'method', text: 'x'.repeat(6), block_idx: 'abc', kind: 'quote', quote: '一二三四五六七八', risk: 3, dimension: 'logic' }],
  });
  assert.equal(r.success, false, '规整不出来就必须失败，不能瞎猜');
});

test('ClaimsOut：dimension 误用 type 的值（"method"）→ 有依据地映射为 depth', () => {
  const r = ClaimsOut.safeParse({
    claims: [{ type: 'method', text: '共线性是否检验过', block_idx: 4, kind: 'quote',
      quote: '并将活动类型作为哑变量处理', risk: 3, dimension: 'method' }],
  });
  assert.equal(r.success, true, '这是个明确的映射，不是猜测');
  if (r.success) assert.equal(r.data.claims[0].dimension, 'depth');
});

test('ClaimsOut：dimension 给完全无关的值（"color"）→ 拒绝', () => {
  const r = ClaimsOut.safeParse({
    claims: [{ type: 'method', text: 'x'.repeat(6), block_idx: 1, kind: 'quote', quote: '一二三四五六七八', risk: 3, dimension: 'color' }],
  });
  assert.equal(r.success, false, '没有依据的值不许默认填充');
});

test('EvaluateOut：absence 必须带 scope', () => {
  const noScope = EvaluateOut.safeParse({
    score: 3, gaps: [], locators: [{ kind: 'absence', block_idx: 2, quote: '' }], followup: null,
  });
  assert.equal(noScope.success, false, 'absence 缺 scope 应被拒');

  const withScope = EvaluateOut.safeParse({
    score: 3, gaps: [], locators: [{ kind: 'absence', block_idx: 2, scope: '第4章', quote: '' }], followup: null,
  });
  assert.equal(withScope.success, true);
});

test('EvaluateOut：locators 至少 1 条（每条评价都要有出处）', () => {
  const bad = EvaluateOut.safeParse({ score: 3, gaps: [], locators: [], followup: null });
  assert.equal(bad.success, false);
});

test('EvaluateOut：score 越界 → 拒绝', () => {
  const bad = EvaluateOut.safeParse({
    score: 6, gaps: [], locators: [{ kind: 'quote', block_idx: 1, quote: '两人独立标注' }], followup: null,
  });
  assert.equal(bad.success, false);
});

test('ReportOut：material_risk 不接受模型给分（不得出现 risk_score）', () => {
  const withScore = ReportOut.safeParse({
    material_risk: [{ dimension: 'evidence', comment: '证据薄弱', risk_score: 88, locators: [] }],
    performance: [], high_risk: [], advice: '建议补充标注口径',
  });
  assert.equal(withScore.success, true, '多余字段默认被 strip');
  if (withScore.success) {
    // @ts-expect-error 运行时确认被剥离
    assert.equal(withScore.data.material_risk[0].risk_score, undefined);
  }
});

test('ReportOut：合法报告（material_risk 无分 + performance 有分）', () => {
  const ok = ReportOut.safeParse({
    material_risk: [
      { dimension: 'evidence', comment: '证据链不完整，未交代标注口径', locators: [{ kind: 'quote', block_idx: 18, quote: '检索命中率提升到 92%' }] },
    ],
    performance: [{ dimension: 'logic', score: 72, comment: '结构清楚' }],
    high_risk: [{ claim_id: 'c1', question: '这个 92% 的分母是什么？', why: '未交代标注口径与标注人', suggestion: '补一句标注说明与样本量' }],
    advice: '回答时先给分母再给数字。',
  });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error?.issues));
});

test('PersonasOut：模型按 prompt 输出（不含 color）→ 必须通过', () => {
  // 【回归测试，对应 2026-10-31 真实 key 首跑暴露的 100% 阻断 Bug】
  // system prompt 明文「不要输出 color 字段（服务端按维度分配传统色）」，
  // 而旧 schema 把 color 设成必填（regex 校验）。两边矛盾的结果：
  // 模型照 prompt 做 → 三元 zod 报错 → POST /api/sessions 直接 502，
  // 整个阶段 3 的聊天入口打不开。mock 抓不到，因为 fixture 里的响应是手写的。
  const ok = PersonasOut.safeParse({
    personas: [
      { name: '周评委', role: 'method', focus: '盯实验设计与数据口径', tone: '语速慢，逼你补数据',
        opening: [{ claim_id: 'c1', question: '这批数据的标注口径是怎么统一的？' }] },
      { name: '许教授', role: 'engineering', focus: '盯工程实现与可复现性', tone: '先肯定再追问',
        opening: [{ claim_id: 'c2', question: '换台机器能跑出同样的结果吗？' }] },
      { name: '陈老师', role: 'value', focus: '盯实际用途与推广边界', tone: '温和但咬住不放',
        opening: [{ claim_id: 'c3', question: '这套方法离开这个场景还成立吗？' }] },
    ],
  });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error?.issues));
});

test('PersonasOut：模型若自作主张带 color → 被 strip，不透传进库', () => {
  const withColor = PersonasOut.safeParse({
    personas: [
      { name: '周评委', role: 'method', focus: '盯实验设计', tone: '语速慢', color: '#ff0000',
        opening: [{ claim_id: 'c1', question: '标注口径怎么统一的？' }] },
    ],
  });
  assert.equal(withColor.success, true, '多余字段不该让整批失败（与 ReportOut 的处理一致）');
  if (withColor.success) {
    // @ts-expect-error 运行时确认被剥离：颜色只能来自服务端 DIM_COLOR
    assert.equal(withColor.data.personas[0].color, undefined);
  }
});

test('PersonasOut：opening 的 claim_id 缺失 → 拒绝', () => {
  const bad = PersonasOut.safeParse({
    personas: [{ name: '周评委', role: 'method', focus: '盯实验设计', tone: '语速慢',
      opening: [{ question: '标注口径怎么统一的？' }] }],
  });
  assert.equal(bad.success, false);
});
