import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, hits, similarity } from '../lib/normalize.ts';

test('norm：全角标点转半角、压空白', () => {
  assert.equal(norm('检索命中率，提升到 92%。'), '检索命中率,提升到 92%.');
  assert.equal(norm('  a   b\t\nc  '), 'a b c');
  assert.equal(norm('\u200b零宽\uFEFF'), '零宽');
});

test('hits：逐字命中（归一化后 includes）', () => {
  const text = '我们采用两人独立标注，不一致由第三人裁决。';
  assert.equal(hits(text, '两人独立标注'), true);
  assert.equal(hits(text, '两人 独立标注'), true, '空白差异应被归一化吃掉');
  assert.equal(hits(text, '三人独立标注'), false);
});

test('similarity：编辑距离相似度', () => {
  assert.equal(similarity('这个问题怎么解释', '这个问题怎么解释'), 1);
  assert.ok(similarity('这个检索服务是同步还是异步', '这个检索服务是同步还是异步的呢') > 0.8);
  assert.ok(similarity('完全不同的一句话', '另外一个主题的问题') < 0.5);
  assert.equal(similarity('', 'x'), 0);
});
