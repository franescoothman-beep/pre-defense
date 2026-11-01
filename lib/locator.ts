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

/**
 * absence 类：不比对文字，校验「我查过这一段」的声明是否成立
 *
 * 【scope 的匹配方向必须反过来，这一点踩过一次】
 * 模型给的 scope 通常比章节名**更长**，例如：
 *   scope  = "2. 数据与方法：三所学校的办学性质、生源结构与年级分布"
 *   章节   = "2. 数据与方法"
 * 曾经写成 `norm(b.section).includes(norm(scope))` —— 拿章节名去包含 scope，
 * 因为 scope 更长，永远 false → 一条明明合法的 absence 被判成"未落在已知章节"。
 * 正确的方向是 `scope.includes(章节名)`：看 scope 里有没有出现某个已知章节名。
 *
 * 【比对时必须**去掉全部空白**，这一点又踩了一次】
 * 上面改了方向之后仍然误判，第二个真实样本：
 *   章节 = "2. 数据与方法"（norm 后仍带一个空格）
 *   scope = "考生回答及原文2.数据与方法中三校各年级条数分布"（无空格）
 * "含空格" 不包含 "不含空格" → 仍然 false。
 * 中文材料里"2. 数据与方法"和"2.数据与方法"是同一种东西，
 * 空格只是排版差异，跟 quote 机检是同一个道理（见 normalize.ts 的 hits）。
 * 所以这里也统一用 strip-whitespace 后再比对。
 */
export function verifyAbsence(blocks: Block[], scope: string | undefined, blockIdx: number): VerifyResult {
  if (!scope || !norm(scope)) {
    return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'absence 缺少 scope' };
  }
  if (blockIdx < 0 || blockIdx >= blocks.length) {
    return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'block_idx 越界' };
  }

  /** 去全部空白：中文材料的排版差异不该影响"这一节存不存在"的判定 */
  const strip = (s: string) => norm(s).replace(/\s+/g, '');
  const scopeFlat = strip(scope);

  // scope 太短（"1"、"2."、"第"）不足以构成"我查过某一节"的声明。
  // 【注意门槛只管 scope 一侧】章节名一侧不设长度门槛 ——
  // "摘要""引言"这类 2 字段落标题是真实存在的章节名，材料里明明白白写着，
  // 拿"太短"去拦它等于宣称"你这篇论文没有摘要"。
  // 真要防巧合，靠的是"必须真的存在这个章节"，而不是猜长度。
  if (scopeFlat.length < 2) {
    return { verified: null, resolvedBlockIdx: blockIdx, movedBy: 0, reason: 'scope 未落在已知章节' };
  }

  const hasSection = blocks.some((b) => {
    const sec = strip(b.section ?? '');
    // 空/空白章节名不能通过（否则任何 scope 都"合法"）
    if (sec.length === 0) return false;
    // 方向一（实测最常见）：模型写的是"章节名 + 补充说明"，所以 scope 更长
    if (scopeFlat.includes(sec)) return true;
    // 方向二：模型只写了简称，此时章节名更长。
    // 【这条要求 scope 自己够长】否则 scope="摘要" 会匹配到
    // "摘要与关键词说明"这种更长的章节名——那是巧合，不是真的指那一节。
    if (scopeFlat.length >= 2 && sec.includes(scopeFlat)) return true;
    return false;
  });
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
  /**
   * 【越界必须在这里判，不能靠 result.reason 里的文本】
   * 真实踩过：verifyQuote 是**先查长度、后查范围**，
   * 所以「block_idx=99 + quote 只有 6 个字」会先返回「quote 过短」，
   * 越界判定根本没执行到。若这里只看 reason 是否等于「block_idx 越界」，
   * 这条越界 locator 就会被当成正常条目落库 —— blockIdx 存成 99，
   * 前端拿它去 blocks 表取原文只能拿到空，界面上是一条点不开的引用。
   * 所以边界在入口处直接判，与校验函数内部的检查顺序无关。
   */
  if (!Number.isInteger(input.block_idx) || input.block_idx < 0 || input.block_idx >= blocks.length) {
    return {
      locator: null,
      result: { verified: 0, resolvedBlockIdx: input.block_idx, movedBy: 0, reason: 'block_idx 越界' },
    };
  }

  const result = input.kind === 'absence'
    ? verifyAbsence(blocks, input.scope, input.block_idx)
    : verifyQuote(blocks, input.block_idx, input.quote ?? '');

  const target = blocks[result.resolvedBlockIdx] ?? blocks[input.block_idx];
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
 * 报告的 locator 机检：与 attachLocator 的区别是**位置缺失时不丢内容**。
 *
 * 【为什么报告要单独一个入口】
 * 判分时越界的 locator 该丢（拿它取原文只能拿到空，留着毫无价值）。
 * 但报告里模型可能只给一句引文、不给 block_idx（实测发生过，见 schemas.ts 的 ReportLocatorIn）。
 * 那句引文本身仍然是有信息量的——它是"模型在批评材料里的哪一句话"。
 * 直接丢掉，用户就看不到模型究竟指着什么在说，报告的可读性直接砍半。
 *
 * 所以这里对"位置不可解析"的条目做一件事：**保留 quote，位置标空，verified=0**，
 * 并给出 reason 说明为什么没验证。它进入分母（不是"验证通过"），
 * 用户看到的是一条明确标注"位置未标注"的引用，而不是凭空消失的条目。
 */
export function attachReportLocator(
  blocks: Block[],
  input: { kind?: LocatorKind; block_idx: number; quote?: string; scope?: string },
): { locator: Locator | null; verified: 0 | 1 | null; reason: string } {
  const kind: LocatorKind = input.kind === 'absence' ? 'absence' : 'quote';

  // 位置不可解析（-1、负数、越界）→ 保留内容、标未校验
  const inRange = Number.isInteger(input.block_idx) && input.block_idx >= 0 && input.block_idx < blocks.length;
  if (!inRange) {
    const quote = (input.quote ?? '').trim();
    if (kind === 'absence') {
      // absence 没有 quote 可留，只能如实丢弃（没有内容的条目没有价值）
      return { locator: null, verified: null, reason: 'absence 缺少可解析的位置' };
    }
    if (quote.length < MIN_QUOTE) {
      return { locator: null, verified: 0, reason: 'quote 过短且位置缺失' };
    }
    return {
      locator: {
        blockIdx: -1, // 显式 -1：前端据此不显示可点的位置标签
        page: null,
        section: null,
        quote,
        kind: 'quote',
        scope: undefined,
      },
      verified: 0,
      reason: '模型未给出 block_idx（位置未标注，无法逐字核对）',
    };
  }

  const { locator, result } = attachLocator(blocks, {
    kind,
    block_idx: input.block_idx,
    quote: input.quote,
    scope: input.scope,
  });
  if (!locator) return { locator: null, verified: result.verified, reason: result.reason };
  return { locator, verified: result.verified, reason: result.reason };
}

/**
 * 命中率统计 —— 两类 locator 严格分开
 * quote 分母含未命中（不剔除）；absence 单独算"检索范围覆盖率"
 *
 * 【absence 覆盖率的分子只能是 'scope 合法'】
 * 曾经把 'scope 未落在已知章节' 也算进分子 —— 那等于说"scope 非法"也是"查过了"，
 * 于是这个指标恒为 100%，变成一个永远好看的假指标。
 * 覆盖率的意义正是"模型声称查过的范围，有多少真的落在材料里"，
 * 所以不合法的那些必须留在分母、不能留在分子。
 */
export function rateOf(entries: Array<{ kind: LocatorKind; verified: 0 | 1 | null; reason: string }>) {
  const quoteEntries = entries.filter((e) => e.kind === 'quote');
  const absenceEntries = entries.filter((e) => e.kind === 'absence');
  const quoteHit = quoteEntries.filter((e) => e.verified === 1).length;
  const absenceOk = absenceEntries.filter((e) => e.reason === 'scope 合法').length;
  return {
    quote: { total: quoteEntries.length, hit: quoteHit, rate: quoteEntries.length ? quoteHit / quoteEntries.length : 0 },
    absence: { total: absenceEntries.length, ok: absenceOk, rate: absenceEntries.length ? absenceOk / absenceEntries.length : 0 },
  };
}
