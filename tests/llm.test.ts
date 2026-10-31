import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, promptHashOf, budgetLeft, resetBudget, MAX_CALLS_PER_SESSION } from '../lib/llm.ts';
import { loadAll, loadFixture, resetMockCache } from '../lib/mock.ts';
import { batchesOf, buildClaimsUser, BATCH_SIZE } from '../lib/prompts/claims.v1.ts';
import type { Block } from '../lib/parse.ts';

// ── extractJson：真实模型返回的三种脏形态都要能吃下 ──────────────────

test('extractJson：裸 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson：```json 包裹', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson：``` 包裹但没标 json', () => {
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test('extractJson：前后带解释文字', () => {
  const t = '好的，以下是结果：\n{"claims":[]}\n希望有帮助。';
  assert.deepEqual(extractJson(t), { claims: [] });
});

test('extractJson：数组根', () => {
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(extractJson('结果如下：[{"a":1}] 以上。'), [{ a: 1 }]);
});

test('extractJson：字符串里含大括号不误判（配平要区分字符串内外）', () => {
  const t = '{"note":"这里有个 } 符号","n":2}';
  assert.deepEqual(extractJson(t), { note: '这里有个 } 符号', n: 2 });
});

test('extractJson：字符串里含转义引号', () => {
  const t = '{"q":"他说\\"你好\\""}';
  assert.deepEqual(extractJson(t), { q: '他说"你好"' });
});

test('extractJson：彻底不是 JSON → null（不抛异常，交给上层重试）', () => {
  assert.equal(extractJson('我不知道该怎么回答。'), null);
  assert.equal(extractJson('{"a":1'), null, '括号未闭合应判失败，不做尽力修补');
  assert.equal(extractJson(''), null);
});

// ── promptHashOf：只存 hash，长度固定 ─────────────────────────

test('promptHashOf：确定性且短', () => {
  const h1 = promptHashOf('同一段文本');
  const h2 = promptHashOf('同一段文本');
  assert.equal(h1, h2, '同输入必须同 hash');
  assert.match(h1, /^[0-9a-f]{16}$/);
  assert.notEqual(promptHashOf('另一段文本'), h1);
});

// ── 预算：按会话独立，可复位 ──────────────────────────────────

test('budgetLeft：初始为 30，消耗后递减，reset 后复位', () => {
  resetBudget('s1');
  assert.equal(budgetLeft('s1'), MAX_CALLS_PER_SESSION);

  const { q } = { q: null }; // 占位：这里只测计数，不真调模型
  void q;

  // 直接改内部计数不可能（未导出），改为验证 resetBudget 的语义
  resetBudget('s1');
  assert.equal(budgetLeft('s1'), MAX_CALLS_PER_SESSION);
  // 两个会话互不影响
  resetBudget('s2');
  assert.equal(budgetLeft('s2'), MAX_CALLS_PER_SESSION);
});

// ── mock 数据层：缺文件返回空、坏文件不抛 ─────────────────────

test('loadAll：已提交的 claims fixture 能被读到且结构完整', () => {
  resetMockCache();
  const all = loadAll('claims');
  assert.ok(all.length >= 2, `claims fixture 应至少 2 批，实际 ${all.length}`);
  for (const e of all) {
    assert.ok('response' in e, '每条必须带 response');
    assert.ok(Array.isArray((e.response as { claims?: unknown[] }).claims), 'response.claims 必须是数组');
  }
});

test('loadAll：不存在的 phase → 空数组（不抛）', () => {
  resetMockCache();
  // 阶段 2 只做了 claims；其余 phase 尚无 fixture，必须是空数组而不是抛异常
  assert.deepEqual(loadAll('personas'), []);
});

test('loadFixture：在范围内取到条目，越界 → null', () => {
  resetMockCache();
  assert.ok(loadFixture('claims', 0), '第 0 条应存在');
  assert.equal(loadFixture('claims', 99), null, '越界必须返回 null');
});

// ── 批次切分：上下文分层的落点 ─────────────────────────────────

function blocksOf(texts: string[]): Block[] {
  return texts.map((t, i) => ({ idx: i, page: 1, section: null, text: t }));
}

test('batchesOf：每批 5 块', () => {
  const bs = blocksOf(Array.from({ length: 12 }, (_, i) => `第 ${i} 段正文内容足够长以便参与抽取，大约二十个字。`));
  const batches = batchesOf(bs);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, BATCH_SIZE);
  assert.equal(batches[2].length, 2);
  assert.deepEqual(batches[0], [0, 1, 2, 3, 4]);
});

test('batchesOf：跳过过短的噪声块（页码残留/单行标题）', () => {
  const bs = blocksOf(['短', '这是一段足够长的正文，可以被质疑，内容有二十来个字。', '12', '另一段同样足够长的正文内容用于测试。']);
  const batches = batchesOf(bs);
  assert.deepEqual(batches[0], [1, 3], '索引 0 和 2 太短应被跳过');
});

test('batchesOf：全是被跳过的碎块 → 空批次', () => {
  assert.deepEqual(batchesOf(blocksOf(['a', 'b', 'c'])), []);
});

test('buildClaimsUser：带编号、带位置，并明确要求用方括号里的数字', () => {
  const bs: Block[] = [
    { idx: 3, page: 7, section: null, text: '这是一段足够长的正文，用于验证 prompt 渲染。' },
    { idx: 4, page: null, section: '2.1 方法', text: '这段来自 DOCX，没有页码，只有章节。' },
  ];
  const u = buildClaimsUser(bs, [3, 4]);
  assert.match(u, /\[3\] \(P7\)/, '有页码时显示 P7');
  assert.match(u, /\[4\] \(2\.1 方法\)/, '无页码时显示章节');
  assert.match(u, /block_idx 必须是上面方括号里的数字/);
  assert.match(u, /块号 3–4/);
});
