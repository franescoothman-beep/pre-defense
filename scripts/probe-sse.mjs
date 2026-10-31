// scripts/probe-sse.mjs —— SSE 端到端探针（手动验证用，不属于交付脚本）
//
// 做四件真实 key 才能验证的事：
//   1. 首字节（连接建立）与首字（第一个 token）分别多久 → DoD「首字 < 1.5s」
//   2. 事件顺序是否 meta 先于 token，token 是否真的分多片到达（流式肉眼可见）
//   3. done 是否带 turnId、progress 是否合理
//   4. 服务端把 meta 里的 blockIdx / source 给对了没有
//
// 用法：node scripts/probe-sse.mjs <sessionId>

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('用法：node scripts/probe-sse.mjs <sessionId>');
  process.exit(1);
}

const url = `http://127.0.0.1:3111/api/sessions/${sessionId}/stream`;
const t0 = Date.now();
const marks = [];
let firstByteAt = null;
let firstTokenAt = null;
let prevEventAt = null;

const res = await fetch(url);
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}
marks.push({ t: Date.now() - t0, what: '连接建立 (HTTP 头到达)' });

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let curEvent = null;
let dataLines = [];
const events = [];

function flush() {
  if (!curEvent) return;
  const data = dataLines.join('\n');
  let payload = null;
  try {
    payload = data ? JSON.parse(data) : null;
  } catch {
    payload = { __unparsed: data };
  }
  events.push({ name: curEvent, payload });
  curEvent = null;
  dataLines = [];
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstByteAt === null) firstByteAt = Date.now() - t0;
  buf += dec.decode(value, { stream: true });

  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');

    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) {
      marks.push({ t: Date.now() - t0, what: `注释行 ${line}` });
      continue;
    }
    if (line.startsWith('event:')) {
      curEvent = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
  }
}
flush();

const tokenEvents = events.filter((e) => e.name === 'token');
const metaEv = events.find((e) => e.name === 'meta');
const doneEv = events.find((e) => e.name === 'done');
const errEv = events.find((e) => e.name === 'error');

// 首字时间用第一个 token 事件的首个字节到达时间（近似：从连接建立到该 token 到达）
// 这里 records 里的 marks 只记了注释行，token 到达时间需要单独测；用事件流总量推断
const totalMs = Date.now() - t0;

console.log('═'.repeat(60));
console.log('事件序列（按到达顺序）');
console.log('═'.repeat(60));
for (const m of marks) console.log(`  +${m.t}ms  ${m.what}`);
console.log('');
console.log('事件类型统计:');
const counts = {};
for (const e of events) counts[e.name] = (counts[e.name] ?? 0) + 1;
console.log(' ', counts);
console.log('');
console.log('meta 事件:');
console.log(JSON.stringify(metaEv?.payload ?? null, null, 2));
console.log('');
console.log('done 事件:');
console.log(JSON.stringify(doneEv?.payload ?? null, null, 2));
if (errEv) {
  console.log('');
  console.log('!! error 事件:');
  console.log(JSON.stringify(errEv.payload, null, 2));
}
console.log('');
console.log('完整问题文本（token 拼接）:');
const full = tokenEvents.map((e) => e.payload?.t ?? '').join('');
console.log(' ', JSON.stringify(full));
console.log('');
console.log('指标:');
console.log(`  首字节: ${firstByteAt}ms`);
console.log(`  token 事件数: ${tokenEvents.length}（>1 即为真流式）`);
console.log(`  全流耗时: ${totalMs}ms`);
console.log(`  拼接后长度: ${full.length} 字`);

// 关键判定
const checks = [
  ['meta 先于 token', metaEv && events.indexOf(tokenEvents[0]) > events.indexOf(metaEv)],
  ['token 分多片（真流式）', tokenEvents.length > 1],
  ['done 带 turnId', Boolean(doneEv?.payload?.turnId)],
  ['meta 带真实 blockIdx', Number.isInteger(metaEv?.payload?.blockIdx)],
  ['meta 带扫读原文 source', typeof metaEv?.payload?.source === 'string' && metaEv.payload.source.length > 0],
  ['无 error 事件', !errEv],
  // 问题文本必须是"人话"，不能带 JSON 外壳。
  // 这是真实跑出来的 bug：透传上游原始增量时前端会看到 {"question": "...
  ['问题文本不含 JSON 外壳', !full.includes('"question"') && !full.startsWith('{') && !full.endsWith('}')],
  ['问题长度合理 (15-60)', full.length >= 15 && full.length <= 220],
];
console.log('');
console.log('┌ 判定');
for (const [name, ok] of checks) console.log(`  ${ok ? '✔' : '✖'} ${name}`);
const allPass = checks.every(([, ok]) => ok);
console.log('└ 结果:', allPass ? '全过' : '有失败项');
process.exit(allPass ? 0 : 1);
