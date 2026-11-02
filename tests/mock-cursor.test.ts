import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * mock 回放游标的回归测试（阶段 6 实测踩过的两个坑）。
 *
 * 【坑 1 · phase 串扰】question / evaluate / report 三个 phase 共用同一个
 *   sessionKey（session.id）。若游标只按 sessionKey 计数，一次 /answer 里的
 *   evaluate 会把 question 的游标往前推一格，quick 三问错位成 q1→q3→q3。
 *   → 游标键必须是 `sessionKey:phase`。
 *
 * 【坑 2 · 热重载归零】Next 开发服务器热重载时重新求值 lib/llm.ts，模块顶层
 *   `const mockCursor = new Map()` 被重建 → 游标归零，多问取回同一条。
 *   → 游标必须挂在 globalThis（与 lib/db.ts 的 __db 单例同理）。
 *
 * 这两个行为都可以用真实 fixtures/llm/*.json 驱动 callLLM 直接验证。
 */

// mock 模式：callMock 只在 isMock() 为真时走
process.env.MOCK_LLM = '1';

const SK = 'cursor-test-session';

async function importFresh(): Promise<typeof import('../lib/llm.ts')> {
  return import('../lib/llm.ts');
}

const anySchema = {
  safeParse: (v: unknown) => ({ success: true as const, data: v }),
};

test('游标按 phase 隔离：question 连取三条互不相同且有序', async () => {
  const { callLLM, resetMockCursor } = await importFresh();
  resetMockCursor(SK);
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { data } = await callLLM({
      sessionKey: SK,
      phase: 'question',
      system: 's',
      user: 'u',
      schema: anySchema as never,
      temperature: 0,
    });
    seen.push((data as { question: string }).question);
  }
  assert.equal(new Set(seen).size, 3, `三问必须互不相同，实际：${seen.join(' | ')}`);
});

test('游标按 phase 隔离：evaluate / report 的调用不推动 question 游标', async () => {
  const { callLLM, resetMockCursor } = await importFresh();
  resetMockCursor(SK);
  const q1 = await callLLM({
    sessionKey: SK,
    phase: 'question',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  // 中间插一次别的 phase 的调用（对应真实路径：一次 /answer 会调 evaluate）
  await callLLM({
    sessionKey: SK,
    phase: 'evaluate',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  await callLLM({
    sessionKey: SK,
    phase: 'report',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  const q2 = await callLLM({
    sessionKey: SK,
    phase: 'question',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  // 坑 1 的实况：游标未隔离时这里会取回第 1 问（因为 evaluate 把游标推走了，q2 落回 idx 0 循环）
  assert.notEqual(
    (q1.data as { question: string }).question,
    (q2.data as { question: string }).question,
    'evaluate / report 调用之后，question 的第二条必须还是 q2（不能循环回 q1）',
  );
});

test('游标挂在 globalThis：跨模块重新求值（模拟热重载）不归零', async () => {
  const mod1 = await importFresh();
  mod1.resetMockCursor(SK);
  await mod1.callLLM({
    sessionKey: SK,
    phase: 'question',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  // 模拟热重载的验证方式：tsx 的 ESM import 缓存无法在运行时清除，
  // 所以退而验证游标对象确实挂在 globalThis 上 ——
  // 这是"热重载后仍存活"的直接证据（新模块实例读的是同一个 Map）。
  const g = globalThis as unknown as { __mockCursor?: Map<string, number> };
  assert.ok(g.__mockCursor instanceof Map, 'mockCursor 必须挂在 globalThis.__mockCursor 上');
  const before = [...g.__mockCursor!.entries()].filter(([k]) => k.startsWith(`${SK}:question`));
  assert.equal(before.length, 1, 'SK:question 键必须存在');
  // 重新 import 得到同一游标（同一 globalThis 对象）
  const mod2 = await importFresh();
  await mod2.callLLM({
    sessionKey: SK,
    phase: 'question',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  const after = g.__mockCursor!.get(`${SK}:question`);
  assert.equal(after, 2, `同一 globalThis 游标应连续计数到 2，实际 ${after}`);
});

test('resetMockCursor：前缀清理该场所有 phase（重抽语义）', async () => {
  const { callLLM, resetMockCursor } = await importFresh();
  resetMockCursor(SK);
  await callLLM({ sessionKey: SK, phase: 'question', system: 's', user: 'u', schema: anySchema as never, temperature: 0 });
  await callLLM({ sessionKey: SK, phase: 'evaluate', system: 's', user: 'u', schema: anySchema as never, temperature: 0 });
  resetMockCursor(SK); // 重抽：这场名下所有 phase 归零
  const g = globalThis as unknown as { __mockCursor?: Map<string, number> };
  assert.ok(![...g.__mockCursor!.keys()].some((k) => k.startsWith(`${SK}:`)), '复位后该场名下不应残留任何 phase 游标');
  // 复位后重新从 q1 开始
  const { data } = await callLLM({
    sessionKey: SK,
    phase: 'question',
    system: 's',
    user: 'u',
    schema: anySchema as never,
    temperature: 0,
  });
  assert.ok(typeof (data as { question: string }).question === 'string');
});
