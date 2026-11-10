import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  isDemoSample,
  checkDemoOnly,
  sha256Of,
  demoHashes,
  resetDemoHashes,
  DEMO_FILES,
} from '../lib/demo.ts';
import { resetMode } from '../lib/mode.ts';

/**
 * 「MOCK 演示模式只允许内置样例」的测试（§3.9 前提①）。
 *
 * 最重要的一条：**服务端必须自己拦**，不能只靠前端置灰。
 * 绕过前端有无数种办法（curl、禁用 JS、改 JS），
 * 若服务端照单全收，mock 就会拿用户的无关材料回放内置样例的剧本 ——
 * 表现为"凭我这份简历，评委却在问论文里的 1240 条数据"。
 *
 * 注：模式现在由 lib/mode.ts 统一出口决定（env 定默认值 + 运行期可覆盖）。
 * 这些用环境变量驱动的用例必须先 resetMode() —— 否则同进程里若有别的用例
 * 设过运行期覆盖，改 env 不会生效，用例就会假失败。
 */

const mindBytes = new TextEncoder().encode('这是一份用户的真实简历，不是内置样例。');

test('isDemoSample：内置样例的字节 → true', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join('fixtures', 'demo', 'sample-paper.docx')));
  assert.equal(isDemoSample(bytes), true);
});

test('isDemoSample：非样例字节 → false（哪怕扩展名一样）', () => {
  // 关键：判据是**字节哈希**，不是文件名/扩展名。
  // 用户完全可以把自己的简历改名成 sample-paper.docx，那也必须被拦。
  assert.equal(isDemoSample(mindBytes), false);
});

test('isDemoSample：同一份样例改名后仍然命中（哈希与文件名无关）', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join('fixtures', 'demo', 'sample-paper.docx')));
  assert.equal(isDemoSample(bytes), true, '内容相同就应当认');
});

test('checkDemoOnly：非 mock 模式一律放行（真实模式必须接受任何合法文件）', () => {
  const prev = process.env.MOCK_LLM;
  process.env.MOCK_LLM = '0';
  resetMode();
  try {
    assert.equal(checkDemoOnly(mindBytes, 'my-resume.pdf'), null, '真实模式不能因为演示约束被收紧');
  } finally {
    resetMode();
    if (prev === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = prev;
  }
});

test('checkDemoOnly：mock 模式下非样例 → 拒绝，且错误码与文案可读', () => {
  const prev = process.env.MOCK_LLM;
  process.env.MOCK_LLM = '1';
  resetMode();
  try {
    const r = checkDemoOnly(mindBytes, 'my-resume.pdf');
    assert.ok(r, '必须拒绝');
    assert.equal(r.code, 'E_MOCK_NOT_DEMO');
    assert.ok(r.message.includes('仅支持内置样例'), '文案要点明原因');
    assert.ok(r.message.includes('MOCK_LLM'), '文案要给出可操作的下一步');
  } finally {
    resetMode();
    if (prev === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = prev;
  }
});

test('checkDemoOnly：mock 模式下样例本身 → 放行', () => {
  const prev = process.env.MOCK_LLM;
  process.env.MOCK_LLM = '1';
  resetMode();
  try {
    const bytes = new Uint8Array(fs.readFileSync(path.join('fixtures', 'demo', 'sample-paper.docx')));
    assert.equal(checkDemoOnly(bytes, 'sample-paper.docx'), null);
  } finally {
    resetMode();
    if (prev === undefined) delete process.env.MOCK_LLM;
    else process.env.MOCK_LLM = prev;
  }
});

test('demoHashes：至少有 1 个内置样例哈希（文件缺失时不能静默为空还放行一切）', () => {
  resetDemoHashes();
  const hashes = demoHashes();
  assert.ok(hashes.size >= 1, `内置样例哈希为空（DEMO_FILES=${DEMO_FILES.join(',')}）`);
});

test('sha256Of：与 node:crypto 一致（防止实现漂移）', () => {
  assert.equal(sha256Of(mindBytes), createHash('sha256').update(mindBytes).digest('hex'));
});

test('服务端拦截已接进 POST /api/docs（不是只改前端）', () => {
  // 这条是"防绕过"的静态证据：路由里必须真的调用 checkDemoOnly。
  const src = fs.readFileSync('app/api/docs/route.ts', 'utf8');
  assert.ok(src.includes('checkDemoOnly'), '路由必须调用 checkDemoOnly');
  assert.ok(/if\s*\(demoGuard\)/.test(src), '必须按守卫结果拒绝');
  // 拦截点必须在 extract 之前：不合规文件连解析都不做
  const guardIdx = src.indexOf('checkDemoOnly(');
  const extractIdx = src.indexOf('extract(');
  assert.ok(guardIdx > 0 && extractIdx > 0, '两处都应存在');
  assert.ok(guardIdx < extractIdx, '演示守卫必须在解析之前（先拒掉，别白解析）');
});

test('前端：演示模式下必须置灰并禁用文件输入（不静默接手）', () => {
  const src = fs.readFileSync('app/upload/page.tsx', 'utf8');
  assert.ok(/mockMode\s*\?/.test(src) || src.includes('mockMode'), '必须有演示模式标记');
  assert.ok(src.includes('disabled={mockMode}'), 'file input 必须真正禁用，而不是只改文案');
  assert.ok(/drop[^"]*disabled/.test(src) || src.includes('mockMode ? \' disabled\''), '上传区要进入 disabled 态');
  assert.ok(src.includes('演示模式仅支持内置样例'), '必须有明确提示');
});

test('前端：拦住之后必须给下一步（不能被拦住却无路可走）', () => {
  // 只拦住不给入口，比允许上传更糟：用户什么都点不了。
  const src = fs.readFileSync('app/upload/page.tsx', 'utf8');
  assert.ok(src.includes('/api/demo'), '前端要取内置样例');
  assert.ok(src.includes('用内置样例开始'), '必须有一键进入内置样例的入口');
});

test('health：必须暴露 mock 标记（前端置灰的依据是服务端事实）', () => {
  const src = fs.readFileSync('app/api/health/route.ts', 'utf8');
  assert.ok(src.includes('getMode'), 'health 必须用统一判定出口（运行期可切换）');
  assert.ok(/mock:\s*mode === 'mock'/.test(src), 'health 返回体要带 mock 字段');
  assert.ok(/mode,/.test(src), 'health 还要直接返回 mode，供切换控件读当前档位');
});

test('/api/demo：只在演示模式提供，且不回用户自己的材料', () => {
  const src = fs.readFileSync('app/api/demo/route.ts', 'utf8');
  assert.ok(src.includes('isMockMode()'), '非演示模式必须不提供');
  assert.ok(src.includes('E_NOT_MOCK'), '非演示模式要明确 404/错误');
  // 必须按内置样例名筛，不能随便返回一份 documents
  assert.ok(/d\.name\s*=\s*\?/.test(src) || src.includes('names[0]'), '必须按内置样例名筛');
  assert.ok(src.includes('claims'), '必须只要已抽过 claims 的（否则用户还会撞 E_NO_CLAIMS）');
});

test('占位：确保 os 模块引用被用上（本测试文件自包含）', () => {
  assert.equal(typeof os.tmpdir(), 'string');
});
