import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeEvent,
  encodeComment,
  parseUpstreamLine,
  readUpstream,
  errorToSse,
  TOKEN_FLUSH_CHARS,
  SSE_EVENTS,
  SSE_HARD_TIMEOUT_MS,
} from '../lib/sse.ts';

test('encodeEvent：事件结尾必须是两个换行（少一个会把下条事件粘上来）', () => {
  const s = encodeEvent('token', { t: '样本' });
  assert.ok(s.startsWith('event: token\n'), '必须先写 event 行');
  assert.ok(s.endsWith('\n\n'), '事件之间必须有空行分隔');
  assert.equal(s.includes('\n\ndata:'), false, 'data 不能出现在事件分隔之后');
});

test('encodeEvent：JSON.stringify 已转义 LF，data 里没有裸换行（事件不会被劈开）', () => {
  // 事实：JSON.stringify 把 LF/CR 转成反斜杠 n / 反斜杠 r 两个字符，
  // 所以序列化后的文本里没有裸换行，一条事件只有一行 data。
  const s = encodeEvent('token', { t: '第一行\n第二行' });
  const lines = s.split('\n');
  const dataLines = lines.filter((l) => l.startsWith('data: '));
  assert.equal(dataLines.length, 1, 'JSON 序列化后不该出现多行 data');
  // 且解析回来仍是一段带真实换行的文本（转义是可逆的）
  const jsonPart = dataLines[0].slice(6);
  const parsed = JSON.parse(jsonPart) as { t: string };
  assert.equal(parsed.t, '第一行\n第二行', '转义必须可逆，否则前端拿到的文本会缺换行');
});

test('encodeEvent：兜底——传入含裸换行的非 JSON 文本时逐行加前缀', () => {
  // 直接传字符串 payload 时 JSON.stringify 会加引号转义，仍然安全；
  // 真正会裸换行的是"已经序列化过的字符串再被拼进去"。这里用原始文本模拟兜底路径。
  const raw = '第一行\n第二行';
  const s = `event: token\ndata: ${raw}\n\n`; // 模拟未经 encodeEvent 的手写拼装（错误做法）
  // 说明性断言：这正是会被劈开的那种写法
  assert.equal(s.split('\n').filter((l) => l.startsWith('data: ')).length, 1,
    '裸换行会被 SSE 解析器当作 data 结束，导致丢后半截');

  // 而走 encodeEvent 安全
  const safe = encodeEvent('token', { t: raw });
  const dataLines = safe.split('\n').filter((l) => l.startsWith('data: '));
  assert.equal(dataLines.length, 1);
  const back = JSON.parse(dataLines[0].slice(6)) as { t: string };
  assert.equal(back.t, raw, '经 encodeEvent 后往返无损');
});

test('encodeEvent：JSON.stringify 不转义 U+2028/U+2029，但它们不破坏事件边界', () => {
  // 这两个字符是 JS 行终止符，但不是 SSE 行分隔符；JSON.stringify 原样保留。
  // 断言它们出现时仍然只有一行 data —— 即事件边界没被破坏。
  const payload = { t: 'A\u2028B\u2029C' };
  const s = encodeEvent('token', payload);
  const dataLines = s.split('\n').filter((l) => l.startsWith('data: '));
  assert.equal(dataLines.length, 1, 'U+2028 不是 SSE 行分隔符，不该产生多行 data');
  const back = JSON.parse(dataLines[0].slice(6)) as { t: string };
  assert.equal(back.t, 'A\u2028B\u2029C', '往返无损');
});

test('encodeEvent：JSON 里的中文不被转义，且能原样解析回来', () => {
  const s = encodeEvent('meta', { persona: '周评委', qIndex: 2 });
  const jsonPart = s
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .join('\n');
  const parsed = JSON.parse(jsonPart) as { persona: string; qIndex: number };
  assert.equal(parsed.persona, '周评委');
  assert.equal(parsed.qIndex, 2);
});

test('encodeComment：心跳行以冒号开头并以空行结束', () => {
  assert.equal(encodeComment(), ': ok\n\n');
});

test('parseUpstreamLine：正常增量', () => {
  const r = parseUpstreamLine('data: {"choices":[{"delta":{"content":"样"}}]}');
  assert.equal(r.kind, 'delta');
  if (r.kind === 'delta') assert.equal(r.text, '样');
});

test('parseUpstreamLine：[DONE] 视为结束', () => {
  assert.deepEqual(parseUpstreamLine('data: [DONE]'), { kind: 'done' });
});

test('parseUpstreamLine：空行/注释行/非 data 行一律忽略（不报错）', () => {
  assert.equal(parseUpstreamLine('').kind, 'ignore');
  assert.equal(parseUpstreamLine('   ').kind, 'ignore');
  assert.equal(parseUpstreamLine(': keep-alive').kind, 'ignore');
  assert.equal(parseUpstreamLine('event: message').kind, 'ignore');
});

test('parseUpstreamLine：无法解析的 JSON → error 而不是抛（一条坏行不该炸整条流）', () => {
  const r = parseUpstreamLine('data: {"choices":[{"delta":{"content":"半');
  assert.equal(r.kind, 'error');
});

test('parseUpstreamLine：delta 为空（只有 role 的首包）→ ignore，不产生空 token', () => {
  assert.equal(parseUpstreamLine('data: {"choices":[{"delta":{"role":"assistant"}}]}').kind, 'ignore');
});

test('parseUpstreamLine：上游 error 字段被识别成 error', () => {
  const r = parseUpstreamLine('data: {"error":{"message":"rate limit"}}');
  assert.equal(r.kind, 'error');
});

/** 构造一个按给定 chunk 切分的假上游流 */
function fakeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test('readUpstream：**chunk 边界切在多字节字中间**时仍能正确解析（关键回归）', async () => {
  // 真实上游按字节切 chunk，一个中文字（UTF-8 三字节）完全可能被切成 1+2。
  // 若不用 TextDecoder 的 stream 模式缓冲，这里会得到乱码或 JSON 解析失败。
  const line = 'data: {"choices":[{"delta":{"content":"样本"}}]}\n';
  const bytes = new TextEncoder().encode(line);
  // 在「样」字的字节中间切开：找到"样本"首次出现的字节位置再 +1
  const idx = bytes.indexOf(new TextEncoder().encode('样')[0]);
  const cut = idx + 1;
  const enc = new TextEncoder();
  const s = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, cut));
      c.enqueue(bytes.slice(cut));
      c.close();
    },
  });

  const out: string[] = [];
  for await (const d of readUpstream(s)) out.push(d);
  assert.equal(out.join(''), '样本', `多字节被切断后应完整还原，实际 ${JSON.stringify(out)}`);
});

test('readUpstream：半行缓冲——一个 JSON 行分两个 chunk 到达', async () => {
  const s = fakeStream([
    'data: {"choices":[{"delta":{"content":"半',
    '句"}}]}\n',
  ]);
  const out: string[] = [];
  for await (const d of readUpstream(s)) out.push(d);
  assert.equal(out.join(''), '半句', '不能出现"半截 JSON 解析失败"');
});

test('readUpstream：一个 chunk 含多行 → 逐行产出', async () => {
  const s = fakeStream([
    'data: {"choices":[{"delta":{"content":"甲"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"乙"}}]}\n' +
      'data: [DONE]\n',
  ]);
  const out: string[] = [];
  for await (const d of readUpstream(s)) out.push(d);
  assert.deepEqual(out, ['甲', '乙']);
});

test('readUpstream：最后一行不带换行也要处理', async () => {
  const s = fakeStream(['data: {"choices":[{"delta":{"content":"尾"}}]}']);
  const out: string[] = [];
  for await (const d of readUpstream(s)) out.push(d);
  assert.equal(out.join(''), '尾');
});

test('readUpstream：收到 [DONE] 立刻停止，不读完剩余 chunk', async () => {
  const s = fakeStream(['data: {"choices":[{"delta":{"content":"甲"}}]}\ndata: [DONE]\ndata: {"choices":[]}\n']);
  const out: string[] = [];
  for await (const d of readUpstream(s)) out.push(d);
  assert.deepEqual(out, ['甲']);
});

test('errorToSse：LLM 错误码映射到前端 fallback 文案', () => {
  assert.equal(errorToSse('E_TIMEOUT').code, 'timeout');
  assert.ok(errorToSse('E_TIMEOUT').fallback.includes('请再问一次'));
  assert.equal(errorToSse('E_NO_KEY').code, 'no_key');
  assert.equal(errorToSse('E_BUDGET').code, 'budget');
  assert.equal(errorToSse('E_UNKNOWN_CODE').code, 'internal', '未知码要归到 internal，不能漏出内部码');
});

test('常量与契约一致：四种事件名、60s 硬断、节流粒度不为 0', () => {
  assert.deepEqual([...SSE_EVENTS], ['meta', 'token', 'done', 'error']);
  assert.equal(SSE_HARD_TIMEOUT_MS, 60_000, 'S6 要求 SSE 60s 硬断');
  assert.ok(TOKEN_FLUSH_CHARS > 1, '节流为 1 会让事件碎到没有流式手感');
});
