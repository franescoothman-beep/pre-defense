// lib/demo.ts —— 「MOCK 演示模式只允许内置样例」的判定（纯函数，前后端共用）
//
// 【为什么必须有服务端拦截，不能只靠前端置灰】
// 前端置灰是"友好提示"，不是"防护"。绕过前端有无数种办法：
// 直接 curl、禁用 JS、改 JS、复用旧的 fetch。
// 若服务端照单全收，那 mock 模式就会拿用户的**无关文件**去回放内置样例的剧本 ——
// 表现为"凭我这份简历，评委却在问论文里的 800 条评测集"，
// 这正是 §3.9 说的"不静默接手"要禁止的事。
//
// 【为什么判据是内容指纹，不是 docId / 文件名】
// docId 是上传时新生成的 UUID（实测库里已有 8 份字节完全相同的 sample-paper.docx，
// 各自是不同 UUID）。文件名更是可以随便改。
// 只有"文件字节的哈希"是稳定的：同一份内置样例，无论上传多少次、叫什么名字，哈希都一致。
//
// 【为什么会话的 mock 回放依赖这一点】
// mock 是**序号驱动**（C15），不按内容路由。所以只要用户上传的是别的文件，
// 系统仍然会回放内置样例的那套问题 —— 内容对不上，模型看起来像在说胡话。
// 拦住它，才是对用户诚实。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMockMode as runtimeMockMode } from './mode';

/** 内置样例所在目录（相对仓库根） */
export const DEMO_DIR = path.join('fixtures', 'demo');

/** 内置样例文件名（与 fixtures/demo 里实际存在的文件一一对应） */
export const DEMO_FILES = ['sample-paper.docx'] as const;

/** 是否处于 MOCK 演示模式（唯一判定出口，运行期可被 /api/mode 覆盖） */
export function isMockMode(): boolean {
  return runtimeMockMode();
}

/** 文件字节的 sha256（十六进制） */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 内置样例的哈希清单（惰性读取 + 进程内缓存）。
 *
 * 缓存是安全的：内置样例文件是仓库资产，运行期不会变。
 * 若测试里需要构造"样例被换掉"的场景，用 `resetDemoHashes()` 清缓存。
 */
let cachedHashes: Set<string> | null = null;

export function demoHashes(): Set<string> {
  if (cachedHashes) return cachedHashes;
  const out = new Set<string>();
  for (const name of DEMO_FILES) {
    const p = path.join(process.cwd(), DEMO_DIR, name);
    try {
      out.add(sha256Of(new Uint8Array(fs.readFileSync(p))));
    } catch {
      // 样例文件缺失：不把整个演示模式打死，只是此时"什么都对不上"。
      // 会在调用处被当成"不是内置样例"，从而拒绝上传 —— 这是安全的失败方向。
      console.warn(`[demo] 内置样例缺失：${p}`);
    }
  }
  cachedHashes = out;
  return out;
}

/** 测试用：清掉哈希缓存 */
export function resetDemoHashes(): void {
  cachedHashes = null;
}

/** 这份字节是不是内置样例之一 */
export function isDemoSample(bytes: Uint8Array): boolean {
  return demoHashes().has(sha256Of(bytes));
}

/**
 * 服务端拦截的判定入口。
 *
 * 返回 null 表示放行；返回对象表示拒绝（由路由转成 4xx）。
 *
 * 注意：**只在 mock 模式下拦截**。真实模式必须照常接受任何合法 PDF/DOCX ——
 * 那是产品本体，不能因为"演示模式有约束"就把真实模式一起收紧。
 */
export type DemoGuardResult = { code: 'E_MOCK_NOT_DEMO'; message: string } | null;

export function checkDemoOnly(bytes: Uint8Array, filename: string): DemoGuardResult {
  if (!isMockMode()) return null;
  if (isDemoSample(bytes)) return null;

  return {
    code: 'E_MOCK_NOT_DEMO',
    message:
      `演示模式仅支持内置样例（${DEMO_FILES.join(' / ')}）。` +
      `你上传的「${filename}」不是内置样例。` +
      `若要看自己的材料，请在页面顶部切到「真实 · 实时模型」模式` +
      `（或把 MOCK_LLM 设为 0 后重启）并配置模型密钥；` +
      `或在演示模式下改用内置样例。`,
  };
}
