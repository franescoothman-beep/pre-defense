import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuote, verifyAbsence, attachLocator, rateOf } from '../lib/locator';
import { paragraphsToBlocks } from '../lib/parse';

const blocks = paragraphsToBlocks([
  '第1章 研究背景',
  '我们采用两人独立标注，不一致由第三人裁决，最终得到 100 条标注样本。',
  '检索命中率提升到 92%，显著优于基线方案。',
  '本章小结。',
]);
const idx = 1;

test('verifyQuote：原地命中', () => {
  // 注意：quote 有 8 字下限，太短必误命中，所以这里用 8 字以上
  const r = verifyQuote(blocks, idx, '两人独立标注，不一致由第三人裁决');
  assert.equal(r.verified, 1);
  assert.equal(r.movedBy, 0);
  assert.equal(r.reason, '原地命中');
});

test('verifyQuote：邻域命中（块号错了但仍可溯源）', () => {
  // 句子在块 2，故意传块 1 → 应在 ±2 邻域里找到
  const r = verifyQuote(blocks, idx, '显著优于基线方案');
  assert.equal(r.verified, 1);
  assert.equal(r.resolvedBlockIdx, 2);
  assert.ok(r.movedBy !== 0, '应发生位置修正');
});

test('verifyQuote：未命中 → verified=0 且不丢弃数据', () => {
  const r = verifyQuote(blocks, idx, '这句话在原文里根本没有出现过');
  assert.equal(r.verified, 0);
  assert.equal(r.reason, '未命中');
});

test('verifyQuote：quote 过短直接判 0（太短必误命中）', () => {
  const r = verifyQuote(blocks, idx, '两人');
  assert.equal(r.verified, 0);
  assert.match(r.reason, /过短/);
});

test('verifyQuote：block_idx 越界 → 判 0', () => {
  const r = verifyQuote(blocks, 99, '两人独立标注，不一致由第三人裁决');
  assert.equal(r.verified, 0);
  assert.match(r.reason, /越界/);
});

test('verifyAbsence：scope 命中已知章节 → 合法', () => {
  const r = verifyAbsence(blocks, '第1章 研究背景', 3);
  assert.equal(r.verified, null, 'absence 不参与逐字机检');
  assert.match(r.reason, /scope 合法/);
});

test('verifyAbsence：缺 scope → 记入失败原因', () => {
  const r = verifyAbsence(blocks, undefined, 3);
  assert.equal(r.verified, null);
  assert.match(r.reason, /缺少 scope/);
});

test('attachLocator：回填 page/section', () => {
  const { locator } = attachLocator(blocks, { kind: 'quote', block_idx: idx, quote: '两人独立标注，不一致由第三人裁决' });
  assert.ok(locator);
  assert.equal(locator!.blockIdx, idx);
  assert.equal(locator!.section, '第1章 研究背景');
  assert.equal(locator!.page, null, 'flow 模式 page 必须为 null');
  assert.equal(locator!.kind, 'quote');
});

test('rateOf：两类 locator 严格分开统计（分母含未命中）', () => {
  const stats = rateOf([
    { kind: 'quote', verified: 1, reason: '原地命中' },
    { kind: 'quote', verified: 0, reason: '未命中' },
    { kind: 'absence', verified: null, reason: 'scope 合法' },
  ]);
  assert.equal(stats.quote.total, 2);
  assert.equal(stats.quote.hit, 1);
  assert.equal(stats.quote.rate, 0.5);
  assert.equal(stats.absence.total, 1);
  assert.equal(stats.absence.rate, 1);
});
