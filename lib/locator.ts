// lib/locator.ts —— 锚点机检（纯函数）
// quote 类：逐字命中（归一化后 includes），失败在 ±2 块邻域重试一次
// absence 类：不机检，改为校验 scope 是否落在本文档有效范围内
import { norm, hits } from './normalize';
import type { Block } from './parse';

export type LocatorKind = 'quote' | 'absence';

export type Locator = {
  blockIdx: number;
  page: number | null;
  section: string | null;
  quote: string;
  kind: LocatorKind;
  scope?: string;
};

export type VerifyResult = {
  verified: 0 | 1 | null; // quote：1/0；absence：null（不参与逐字机检）
  resolvedBlockIdx: number;
  /** 邻域重试是否生效（写进 ai-log 与评测，诊断 prompt 质量） */
  movedBy: number;
  reason: string;
};

const MIN_QUOTE = 8;
const MAX_QUOTE = 60;
const NEIGHBOR = 2;

/** quote 类：校验长度 → 原地命中 → ±2 邻域 → 失败标 0（保留数据，不丢） */
export function verifyQuote(blocks: Block[], blockIdx: number, quote: string): VerifyResult {
  if (!quote || quote.length < MIN_QUOTE) {
    return { verified: 0, resolvedBlockIdx: blockIdx, movedBy: 0, reason: `quote 过短(<${MIN_QUOTE})` };
  }
  if (quote.length > MAX_QUOTE) {
    return { verified: 0, resolvedBlockIdx: blockIdx, movedBy: 0, reason: `quote 过长(>${MAX_QUOTE})` };
  }
  if (blockIdx < 0 || blockIdx >= blocks.length) {
    return { verified: 0, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'block_idx 越界' };
  }

  if (hits(blocks[blockIdx].text, quote)) {
    return { verified: 1, resolvedBlockIdx: blockIdx, movedBy: 0, reason: '原地命中' };
  }

  for (let d = 1; d <= NEIGHBOR; d++) {
    for (const cand of [blockIdx - d, blockIdx + d]) {
      if (cand < 0 || cand >= blocks.length) continue;
      if (hits(blocks[cand].text, quote)) {
        return { verified: 1, resolvedBlockIdx: cand, movedBy: d, reason: `邻域命中(${d > 0 ? (cand < blockIdx ? '-' : '+') + d : 0})` };
      }
    }
  }

  // 整篇兜底：模型偶尔给对句子但给错块号，这仍然算"可溯源"
  for (let i = 0; i < blocks.length; i++) {
    if (i === blockIdx) continue;
    if (hits(blocks[i].text, quote)) {
      return { verified: 1, resolvedBlockIdx: i, movedBy: i - blockIdx, reason: '全篇兜底命中' };
    }
  }

  return { verified: 0, resolvedBlockIdx: blockIdx, movedBy: 0, reason: '未命中' };
}

/** absence 类：不比对文字，校验「我查过这一段」的声明是否成立 */
export function verifyAbsence(blocks: Block[], scope: string | undefined, blockIdx: number): VerifyResult {
  if (!scope || !norm(scope)) {
    return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'absence 缺少 scope' };
  }
  if (blockIdx < 0 || blockIdx >= blocks.length) {
    return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'block_idx 越界' };
  }
  const hasSection = blocks.some((b) => b.section && norm(b.section).includes(norm(scope)));
  const looksLikeRange = /\d+\s*[–\-~]\s*\d+/.test(scope) || /§/.test(scope);
  if (hasSection || looksLikeRange) {
    return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'scope 合法' };
  }
  return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'scope 未落在已知章节' };
}

/** 统一入口：按 kind 分派，返回可直接落库的 locator */
export function attachLocator(
  blocks: Block[],
  input: { kind: LocatorKind; block_idx: number; quote?: string; scope?: string },
): { locator: Locator | null; result: VerifyResult } {
  const base = blocks[input.block_idx];
  const result = input.kind === 'absence'
    ? verifyAbsence(blocks, input.scope, input.block_idx)
    : verifyQuote(blocks, input.block_idx, input.quote ?? '');

  if (result.reason === 'block_idx 越界') return { locator: null, result };

  const target = blocks[result.resolvedBlockIdx] ?? base;
  return {
    locator: {
      blockIdx: result.resolvedBlockIdx,
      page: target?.page ?? null,
      section: target?.section ?? null,
      quote: input.kind === 'absence' ? '' : input.quote ?? '',
      kind: input.kind,
      scope: input.kind === 'absence' ? input.scope : undefined,
    },
    result,
  };
}

/**
 * 命中率统计 —— 两类 locator 严格分开
 * quote 分母含未命中（不剔除），absence 单独算"检索范围覆盖率"
 */
export function rateOf(entries: Array<{ kind: LocatorKind; verified: 0 | 1 | null; reason: string }>) {
  const quoteEntries = entries.filter((e) => e.kind === 'quote');
  const absenceEntries = entries.filter((e) => e.kind === 'absence');
  const quoteHit = quoteEntries.filter((e) => e.verified === 1).length;
  const absenceOk = absenceEntries.filter((e) => e.reason === 'scope 合法' || e.reason === 'scope 未落在已知章节').length;
  return {
    quote: { total: quoteEntries.length, hit: quoteHit, rate: quoteEntries.length ? quoteHit / quoteEntries.length : 0 },
    absence: { total: absenceEntries.length, ok: absenceOk, rate: absenceEntries.length ? absenceOk / absenceEntries.length : 0 },
  };
}
