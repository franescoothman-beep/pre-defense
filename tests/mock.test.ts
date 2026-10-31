import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * MOCK 回放闭环 + 常驻角标的契约测试。
 *
 * §3.9 的三条前提，每条都对应一个真实失败模式：
 *   ① 只允许内置样例（用户上传自己的文件必须被拦住）
 *   ② 序号驱动而非内容驱动（同一场内顺序固定 → 回放自洽）
 *   ③ 常驻角标（不标 = 评委以为你在编数据）
 */

const fixturesDir = 'fixtures/llm';

function loadSeq(phase: string): Array<{ inputHash?: string; response: unknown }> {
  const p = path.join(fixturesDir, `${phase}.json`);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j.seq) ? j.seq : [];
}

test('fixtures：personas / question 必须存在且非空（零 key 闭环的前提）', () => {
  // 这两个文件缺任何一个，MOCK_LLM=1 下建会话或 SSE 直接报 E_MOCK_MISS
  const personas = loadSeq('personas');
  const question = loadSeq('question');
  assert.ok(personas.length >= 1, `personas.json 至少 1 条，实际 ${personas.length}`);
  assert.ok(question.length >= 3, `question.json 至少 3 条（quick 档三问），实际 ${question.length}`);
});

test('fixtures：personas 每位评委的 opening 必须落在**自己席位**的候选里', () => {
  // 【真实踩过的坑】第一次录制时三位评委的 opening 全用同一条 claim，
  // 结果服务端锚点归属校验把第 2、3 位过滤掉，mock 只产出 1 位评委（judges:1 而 seated:3）。
  // 这是"录制方式错"，不是产品错。这里用测试钉住：三位的 claim_id 必须**互不相同**。
  const entries = loadSeq('personas');
  const personas = (entries[0].response as { personas: Array<{ opening: Array<{ claim_id: string }> }> }).personas;
  const ids = personas.map((p) => p.opening[0]?.claim_id ?? '');
  assert.equal(ids.length, 3, 'mock 演示需要 3 位评委');
  assert.equal(
    new Set(ids).size,
    ids.length,
    `三位评委的 claim_id 必须互不相同（否则锚点归属校验会过滤掉重复的），实际：${ids.join(', ')}`,
  );
  for (const id of ids) assert.ok(id.length > 0, '每个 opening 都要有 claim_id');
});

test('fixtures：question 每条都能过 QuestionOut（question 为 6–200 字字符串）', async () => {
  const { QuestionOut } = await import('../lib/schemas.ts');
  for (const [i, e] of loadSeq('question').entries()) {
    const ok = QuestionOut.safeParse(e.response);
    assert.equal(ok.success, true, `第 ${i + 1} 条 question fixture 不合 QuestionOut 结构`);
  }
});

test('fixtures：存的是"系统真实返回的形状"，不是模型原始自由文本', () => {
  // 手写 fixture 会让 mock 静默通过一个真实模式会失败的结构（阶段 2 的 quote 就是）。
  // 这里检查：question fixture 必须是对象 {question}，不能是一段字符串。
  for (const e of loadSeq('question')) {
    assert.equal(typeof e.response, 'object', 'response 必须是对象（JSON 结构），不是裸字符串');
    assert.ok(Object.prototype.hasOwnProperty.call(e.response as object, 'question'), 'response 必须含 question 字段');
  }
});

test('phase：question 必须与 evaluate 分开（否则 mock 游标会去取没录的 evaluate）', () => {
  // 【真实踩过的坑】SSE 路由曾把 phase 写成 'evaluate'，
  // mock 于是去找 evaluate 的第 1 条 —— 那条还没录 → E_MOCK_MISS，
  // 表现为"mock 模式下 SSE 直接报内部错误"。
  const llmSrc = fs.readFileSync('lib/llm.ts', 'utf8');
  assert.ok(/export type Phase = '[^']+'[^;]*'question'/.test(llmSrc), 'Phase 类型必须包含 question');

  const routeSrc = fs.readFileSync('app/api/sessions/[id]/stream/route.ts', 'utf8');
  assert.ok(/phase:\s*'question'/.test(routeSrc), 'SSE 出题必须用 question phase');
  assert.ok(!/phase:\s*'evaluate'/.test(routeSrc), 'SSE 路由里不该再出现 evaluate phase（那是阶段 4 的判分）');
});

test('MOCK 角标：必须在全局 layout 挂载（服务端渲染，客户端无法隐藏）', () => {
  const layout = fs.readFileSync('app/layout.tsx', 'utf8');
  assert.ok(layout.includes('MockBadge'), 'layout 必须挂角标');
  assert.ok(layout.includes('variant="header"'), '全局用 header 形态');
});

test('MOCK 角标：由服务端读 MOCK_LLM，且非 mock 时返回 null 不占位', () => {
  const src = fs.readFileSync('components/MockBadge.tsx', 'utf8');
  assert.ok(src.includes("process.env.MOCK_LLM === '1'"), '必须服务端读环境变量（客户端无法伪造）');
  assert.ok(/if \(!isMockMode\(\)\) return null/.test(src), '非 mock 模式必须完全不渲染');
});

test('MOCK 角标：文案必须明确"录制回放，非实时模型输出"', () => {
  // 「不标 = 评委以为你在编数据」。所以文案不能只说"演示模式"，
  // 必须说清楚"发言是回放、不是实时模型输出"。
  const src = fs.readFileSync('components/MockBadge.tsx', 'utf8');
  assert.ok(src.includes('录制回放'), '必须写明是录制回放');
  assert.ok(src.includes('非实时模型输出') || src.includes('不是实时模型输出'), '必须写明不是实时模型输出');
  assert.ok(src.includes('仅支持内置样例'), '必须写明只支持内置样例（§3.9 前提①）');
});

test('MOCK 角标：不许有动效（4 处清单已用 3，角标不该占第 4 位）', () => {
  const css = fs.readFileSync('components/MockBadge.css', 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(stripped.match(/animation\s*:/g), null, '角标不许有 animation');
  assert.equal(stripped.match(/@keyframes/g), null, '角标不许有 keyframes');
});
