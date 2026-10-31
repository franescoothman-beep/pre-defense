import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * SSE 路由的静态约定检查。
 *
 * 这里只检查"结构性事实"（有没有用某个常量、有没有监听 abort、有没有日志），
 * **不检查 insert 的参数个数**——那类校验改成真实 SQLite 行为测试
 * （tests/turns-insert.test.ts），因为用正则数 JS 实参会在字符串逗号、嵌套调用上误判。
 */

const routePath = 'app/api/sessions/[id]/stream/route.ts';

test('stream 路由：60s 硬断与节流粒度走常量，不在路由里写魔法数字', () => {
  const src = fs.readFileSync(routePath, 'utf8');
  assert.ok(src.includes('SSE_HARD_TIMEOUT_MS'), '必须引用 lib/sse.ts 的硬断常量');
  assert.ok(!src.includes('60000'), '不该在路由里直接出现 60000');
  assert.ok(src.includes('TOKEN_FLUSH_CHARS'), '节流粒度必须走常量');
});

test('stream 路由：客户端断开时 abort 上游（S6 不留孤儿请求）', () => {
  const src = fs.readFileSync(routePath, 'utf8');
  assert.ok(src.includes('req.signal.addEventListener'), '必须监听客户端 abort');
  assert.ok(src.includes('controller.abort()'), 'abort 时要把上游一起掐掉');
  assert.ok(src.includes('signal: controller.signal'), '调用模型时必须把 signal 传进去');
});

test('stream 路由：错误分支必须有服务端日志（否则只剩一句"内部错误"）', () => {
  const src = fs.readFileSync(routePath, 'utf8');
  assert.ok(src.includes('console.error'), 'SSE 的 error 事件不能吞掉堆栈');
});

test('stream 路由：下发前只推解包后的可见文本（不把 JSON 外壳流给前端）', () => {
  const src = fs.readFileSync(routePath, 'utf8');
  assert.ok(src.includes("createFieldStreamer('question')"), '必须用字段解包器');
  // 关键：token 事件里推的必须是解包后的 buffered，而不是原始 delta
  assert.ok(!/push\(encodeEvent\('token', \{ t: delta \}\)/.test(src), '不能把原始增量直接推给前端');
});

test('stream 路由：待回答的 turn 判定要求问题非空（防空评委发言）', () => {
  const src = fs.readFileSync(routePath, 'utf8');
  assert.ok(
    src.includes('question is not null and question != '),
    '重播查询必须排除 question 为空的半成品 turn，否则前端会显示一条空白发言',
  );
});
