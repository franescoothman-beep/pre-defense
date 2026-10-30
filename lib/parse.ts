// lib/parse.ts —— 文件 → Block[]（纯函数核心，可单测，不碰文件系统与数据库）
import { norm } from './normalize';

export type DocMode = 'paged' | 'flow';
export type DocDensity = 'thin' | 'normal' | 'heavy';

export type Block = {
  idx: number;
  page: number | null;
  section: string | null;
  text: string;
};

/**
 * 章节标题识别（中文论文/项目文档的常见写法）。
 * 注意：真实文档里标题几乎总是「第X章 + 标题文字」或「1.2 + 标题文字」，
 * 不能要求整行只有一个"第X章"。这里只要求**行首**命中标记，且整行不太长（避免把正文段落误判成标题）。
 */
const SECTION_HEAD =
  /^(?:第\s*[一二三四五六七八九十百零〇\d]+\s*[章节部分]|(?:\d+(?:\.\d+){0,3})\s*[\u4e00-\u9fa5A-Za-z]|[一二三四五六七八九十]\s*、)/;

export function isSection(line: string): boolean {
  const t = line.trim();
  if (!SECTION_HEAD.test(t)) return false;
  // 标题不会太长；超过 48 字基本是正文段落
  return t.length <= 48;
}

/** 页眉页脚：同一页里反复出现的短行，或纯页码行 */
const PAGE_NUM_RE = /^[\s\-–—_·]*(?:第\s*\d+\s*页|[-\s]*\d{1,4}[-\s]*|[Pp]age\s*\d+)[\s\-–—_·]*$/;

/**
 * 中文 PDF 的经典问题：每个字是一个 text item，而且 y 坐标有抖动。
 * 处理方式：按 y 容差聚行 → 行内按 x 排序 → 去掉「汉字之间被插入的假空格」。
 */
export function itemsToParagraphs(
  items: Array<{ str: string; transform: number[] }>,
  yTolerance = 2.5,
): string[] {
  const glyphs = items.filter((i) => typeof i.str === 'string' && i.str.length > 0);
  type Row = { y: number; parts: Array<{ x: number; s: string }> };
  const rows: Row[] = [];

  for (const it of glyphs) {
    const x = it.transform[4];
    const y = it.transform[5];
    const row = rows.find((r) => Math.abs(r.y - y) <= yTolerance);
    if (row) row.parts.push({ x, s: it.str });
    else rows.push({ y, parts: [{ x, s: it.str }] });
  }

  rows.sort((a, b) => b.y - a.y); // PDF 坐标 y 向下递减

  return rows.map((r) => {
    const joined = r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join('');
    // 逐字空格化：单个汉字之间被插入空格 → 还原
    return joined.replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '');
  });
}

/** 清洗：去页码/极短噪声行、合并被折断的句子、压空白 */
export function cleanParagraphs(raw: string[]): string[] {
  const out: string[] = [];
  for (const line of raw) {
    const t = line.replace(/[ \t\u00a0]{2,}/g, ' ').trim();
    if (!t) continue;
    if (PAGE_NUM_RE.test(t)) continue;
    if (t.length < 2) continue;
    // 上一段是"半句话"（没有句末标点）且本段不像标题 → 合并
    const prev = out[out.length - 1];
    if (prev && !/[。！？；:.!?;)）]$/.test(prev) && prev.length < 60 && !isSection(t) && !isSection(prev)) {
      out[out.length - 1] = prev + t;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** 段落 → Block[]（flow 模式；docx 走这条） */
export function paragraphsToBlocks(paragraphs: string[]): Block[] {
  const blocks: Block[] = [];
  let section: string | null = null;
  for (const p of paragraphs) {
    if (isSection(p)) section = p.slice(0, 40);
    blocks.push({ idx: blocks.length, page: null, section, text: p });
  }
  return blocks;
}

/** 逐页文本 → Block[]（paged 模式；pdf 走这条） */
export function pagesToBlocks(pages: Array<{ page: number; paragraphs: string[] }>): Block[] {
  const blocks: Block[] = [];
  let section: string | null = null;
  for (const { page, paragraphs } of pages) {
    for (const p of paragraphs) {
      if (isSection(p)) section = p.slice(0, 40);
      blocks.push({ idx: blocks.length, page, section, text: p });
    }
  }
  return blocks;
}

/** 材料体量判定：太薄会走"通用质询"降级（P2-薄材料） */
export function densityOf(blocks: Block[]): DocDensity {
  const chars = blocks.reduce((s, b) => s + b.text.length, 0);
  if (blocks.length < 10 || chars < 1500) return 'thin';
  if (blocks.length > 400 || chars > 120000) return 'heavy';
  return 'normal';
}

/** 给评测与文档用的统计 */
export function statsOf(blocks: Block[]) {
  return {
    blocks: blocks.length,
    chars: blocks.reduce((s, b) => s + b.text.length, 0),
    pages: new Set(blocks.map((b) => b.page).filter((p): p is number => p !== null)).size,
    sections: new Set(blocks.map((b) => b.section).filter((s): s is string => !!s)).size,
  };
}

/** 供 UI 显示：块的一行摘要（不含敏感整段） */
export function previewOf(block: Block, max = 120): string {
  const t = norm(block.text);
  const where = block.page !== null ? `P${block.page}` : block.section ?? '—';
  return `[${where}] ${t.length > max ? t.slice(0, max) + '…' : t}`;
}
