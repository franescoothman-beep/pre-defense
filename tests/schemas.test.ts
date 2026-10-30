import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaimsOut, ReportOut, EvaluateOut } from '../lib/schemas.ts';

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
