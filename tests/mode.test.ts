import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getMode, isMockMode, setMode, resetMode } from '../lib/mode.ts';

/**
 * 运行期模式开关（lib/mode.ts + /api/mode）的回归测试。
 *
 * 【为什么这组测试重要】
 * 模式是"唯一总闸"：它同时决定 ① 上传是否只收内置样例（checkDemoOnly）、
 * ② 评委发言走回放还是真模型（isMock → callMock/callReal）。
 * 如果切换不生效或者会串味，最坏的结果是评委在演示模式里打到真实 API，
 * 或者在真实模式里拿不到自己的材料 —— 两种都会当场翻车。
 *
 * 【每个用例都必须 resetMode()】
 * 覆盖值挂在 globalThis，--test-isolation=none 下同进程用例共享，
 * 不清理就会把覆盖值漏给后面的用例。
 */

test('默认值来自 env：MOCK_LLM=1 → mock，否则 → real', () => {
  const prev = process.env.MOCK_LLM;
  try {
    resetMode();
    process.env.MOCK_LLM = '1';
    assert.equal(getMode(), 'mock');
    assert.equal(isMockMode(), true);

    resetMode();
    process.env.MOCK_LLM = '0';
    assert.equal(getMode(), 'real');
    assert.equal(isMockMode(), false);

    resetMode();
    delete process.env.MOCK_LLM;
    assert.equal(getMode(), 'real', '未设 MOCK_LLM 时默认真实模式（普通 npm run dev）');
  } finally {
    resetMode();
    if (prev === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = prev;
  }
});

test('运行期覆盖优先于 env（不重启即可切换）', () => {
  const prev = process.env.MOCK_LLM;
  try {
    process.env.MOCK_LLM = '1';
    resetMode();
    assert.equal(getMode(), 'mock');

    setMode('real');
    assert.equal(getMode(), 'real', '覆盖值必须压过 env，否则"不重启切换"是假的');
    assert.equal(isMockMode(), false);

    setMode('mock');
    assert.equal(getMode(), 'mock');
  } finally {
    resetMode();
    if (prev === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = prev;
  }
});

test('setMode 幂等：切到当前模式返回 false，真的变了才返回 true', () => {
  try {
    resetMode();
    assert.equal(setMode('mock'), true, '首次写入应视为发生变化');
    assert.equal(setMode('mock'), false, '重复写同一值不算变化');
    assert.equal(setMode('real'), true);
  } finally {
    resetMode();
  }
});

test('resetMode 清掉覆盖，回到 env 默认', () => {
  const prev = process.env.MOCK_LLM;
  try {
    process.env.MOCK_LLM = '1';
    setMode('real');
    assert.equal(getMode(), 'real');
    resetMode();
    assert.equal(getMode(), 'mock', 'reset 后必须回到 env 默认值');
  } finally {
    resetMode();
    if (prev === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = prev;
  }
});

test('/api/mode：只接受 mock | real，非法值 400，且不允许 GET 篡改状态', () => {
  const src = fs.readFileSync('app/api/mode/route.ts', 'utf8');
  assert.ok(/mode !== 'mock' && mode !== 'real'/.test(src), '必须校验取值，否则任意字符串都能写进总闸');
  assert.ok(src.includes('E_MODE'), '非法值要有明确错误码');
  assert.ok(/status: 400/.test(src), '非法值返回 400');
  // GET 只读：不能在 GET 里 setMode（否则预取/爬虫会意外改模式）
  const getBody = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
  assert.ok(!getBody.includes('setMode('), 'GET 必须是只读的');
});

test('/api/mode：POST 成功要刷回当前生效模式（前端据此整页刷新）', () => {
  const src = fs.readFileSync('app/api/mode/route.ts', 'utf8');
  assert.ok(/setMode\(/.test(src), 'POST 必须真的写模式');
  assert.ok(/mode:\s*getMode\(\)/.test(src), '返回体要带生效后的模式');
});

test('health：同时给出 mode 与 mock（切换控件读 mode，旧前端读 mock 不破）', () => {
  const src = fs.readFileSync('app/api/health/route.ts', 'utf8');
  assert.ok(/mode,/.test(src), 'health 要直接返回 mode');
  assert.ok(/mock:\s*mode === 'mock'/.test(src), 'mock 布尔值由 mode 推导，保持向后兼容');
});

test('布局：模式切换控件必须全局挂载（每页都能切）', () => {
  const src = fs.readFileSync('app/layout.tsx', 'utf8');
  assert.ok(src.includes('ModeSwitch'), 'layout 必须挂 ModeSwitch');
});

test('报告接口：mock 事实必须走统一出口，不能再读启动期 env 字面量', () => {
  const src = fs.readFileSync('app/api/reports/[id]/route.ts', 'utf8');
  assert.ok(src.includes('isMockMode()'), '报告页脚注的事实要能反映运行期切换');
  assert.ok(!src.includes("process.env.MOCK_LLM === '1'"), '不允许残留启动期 env 判定（会产生"谎称回放"）');
});
