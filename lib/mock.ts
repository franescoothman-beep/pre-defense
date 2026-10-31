// lib/mock.ts —— fixture 回放的数据层（只负责"第 n 条是什么"，不管游标与校验）
//
// 分工（这条边界很重要）：
//   mock.ts  = 读文件 + 按 phase 取出整个数组（纯数据，可单测）
//   llm.ts   = 管游标、跑 zod、写日志
// 这样 mock 的数据问题（缺文件、结构错）能在单测里被钉死，
// 而不用起一台服务器来复现。
//
// fixture 格式：fixtures/llm/{phase}.json = { seq: [{ inputHash, response }] }
//   - **按 seq 递增回放，不按 inputHash 路由**（C15）：
//     评委乱答时，hash 必然不匹配；若按"最接近的 hash"取，会答非所问。
//     顺序驱动至少保证"同一场会话内自洽"。

import fs from 'node:fs';
import path from 'node:path';
import type { Phase } from './llm';

export type FixtureEntry = {
  /** 记录时的输入指纹，只用于告警，**不参与路由**（C15） */
  inputHash?: string;
  response: unknown;
};

type FixtureFile = { seq?: FixtureEntry[]; notes?: string };

const CACHE = new Map<Phase, FixtureEntry[]>();

function fixturePath(phase: Phase): string {
  return path.join(process.cwd(), 'fixtures', 'llm', `${phase}.json`);
}

/**
 * 读取某个 phase 的全部回放条目。
 * 文件缺失 → 空数组（由 llm.ts 报 E_MOCK_MISS，带可读说明）；
 * 文件坏了 → 也返回空数组，但会在 stderr 留一条 warn（不静默吞）。
 */
export function loadAll(phase: Phase): FixtureEntry[] {
  const cached = CACHE.get(phase);
  if (cached) return cached;

  const file = fixturePath(phase);
  if (!fs.existsSync(file)) {
    CACHE.set(phase, []);
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureFile;
    const seq = Array.isArray(parsed.seq) ? parsed.seq.filter((e) => e && 'response' in e) : [];
    CACHE.set(phase, seq);
    return seq;
  } catch (e) {
    console.warn(`[mock] fixtures/llm/${phase}.json 解析失败：${(e as Error).message}`);
    CACHE.set(phase, []);
    return [];
  }
}

/** 取第 seq 条（0-based）；越界返回 null */
export function loadFixture(phase: Phase, seq: number): FixtureEntry | null {
  const all = loadAll(phase);
  return all[seq] ?? null;
}

/** 回放游标复位（测试与"重新开始一场演示"用） */
export function resetMockCache(): void {
  CACHE.clear();
}
