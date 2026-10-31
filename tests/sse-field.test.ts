import test from 'node:test';
import assert from 'node:assert/strict';
import { createFieldStreamer } from '../lib/sse.ts';

/** 把整段 JSON 按给定切片大小喂进去，收集所有可见增量 */
function collect(json: string, field = 'question', sliceSize = 1): string {
  const s = createFieldStreamer(field);
  let out = '';
  for (let i = 0; i < json.length; i += sliceSize) {
    out += s.push(json.slice(i, i + sliceSize));
  }
  return out;
}

test('createFieldStreamer：只吐字段值，不吐 JSON 外壳', () => {
  // 【回归测试】真实跑 SSE 时发现的问题：透传原始增量会让聊天页显示
  // `{"question": "..."`，把"评委在说话"演成"在看代码"。
  const json = '{"question": "这三所小学是怎么选出来的？"}';
  assert.equal(collect(json), '这三所小学是怎么选出来的？');
});

test('createFieldStreamer：不论怎么切块，结果都一样（流式边界无关）', () => {
  // 这是流式解析的核心不变量：按 1 字、2 字、5 字、整段切，输出必须完全一致。
  const json = '{"question": "样本能代表全市吗？"}';
  const expect = '样本能代表全市吗？';
  for (const n of [1, 2, 3, 5, 7, 100]) {
    assert.equal(collect(json, 'question', n), expect, `切片大小 ${n} 时结果不一致`);
  }
});

test('createFieldStreamer：正确处理转义引号（问题里本身带引号）', () => {
  const json = '{"question": "你说的\\"覆盖\\"具体指什么？"}';
  assert.equal(collect(json), '你说的"覆盖"具体指什么？');
});

test('createFieldStreamer：正确处理 \\n 与 \\uXXXX 转义', () => {
  assert.equal(collect('{"question": "第一行\\n第二行"}'), '第一行\n第二行');
  assert.equal(collect('{"question": "\\u4e2d\\u6587"}'), '中文');
});

test('createFieldStreamer：字段名用子串匹配会误中（必须整键相等）', () => {
  // 若用 includes('question') 之类的偷懒写法，questionX 这类键会误命中。
  const json = '{"questionExtra": "不该出现", "question": "应该出现"}';
  assert.equal(collect(json), '应该出现', '必须按完整键名匹配，不能子串匹配');
});

test('createFieldStreamer：目标字段是数字/对象时放弃，转去找下一个同名字符串', () => {
  // 真实模型偶尔会给 {"question": {"text": "..."}}；此时不该吐出乱码，
  // 也不该把整个对象当字符串。状态机应回到"找下一个键"。
  const json = '{"question": 123, "other": "其它"}';
  assert.equal(collect(json), '', '值不是字符串时不吐任何东西');
});

test('createFieldStreamer：字段缺失 → 输出空串，不抛异常', () => {
  assert.equal(collect('{"gaps": "没有 question 这个键"}'), '');
});

test('createFieldStreamer：isDone 在收尾引号后为真', () => {
  const s = createFieldStreamer('question');
  s.push('{"question": "完整"');
  assert.equal(s.isDone(), true, '值收尾后应标记完成');
});

test('createFieldStreamer：值结束后不再吐出后续字段内容', () => {
  const json = '{"question": "只吐这个", "advice": "不该出现"}';
  assert.equal(collect(json), '只吐这个');
});

test('createFieldStreamer：空字段值', () => {
  assert.equal(collect('{"question": ""}'), '');
});
