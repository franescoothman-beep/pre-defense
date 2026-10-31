// lib/extract.ts —— 文件字节 → Block[]（唯一接触 pdfjs / mammoth 的地方）
//
// 分工：
//   parse.ts   = 纯函数（怎么聚行、怎么清洗、怎么切块、怎么判密度），有单测
//   extract.ts = 接线（把具体库的输出喂给 parse.ts 的函数），有集成测试
// 这么切是为了让"格式库的坑"不污染"解析逻辑的正确性"——后者必须能被单测钉死。
//
// 两种模式：
//   paged : PDF 有物理页 → block.page 有值
//   flow  : DOCX 的格式层没有"页"（分页是 Word 渲染时才确定的）→ page=null，靠 section+quote 溯源
//
// 为什么不用 officeparser（v2.1.2 决策）：它会拖进 tesseract.js（WASM OCR）+ 第二份 pdfjs，
// 装包体积翻倍，而本作品只需要 docx 的纯文本。mammoth 只做 docx → text，干净。

import fs from 'node:fs/promises';
import { itemsToParagraphs, cleanParagraphs, pagesToBlocks, paragraphsToBlocks, dropRunningHeads, densityOf, statsOf } from './parse';
import type { Block, DocMode, DocDensity } from './parse';

/** 可读的业务错误：路由层据此返回 4xx 而不是 500（图片型 PDF 等） */
export class ExtractError extends Error {
  code: 'E_EMPTY_PDF' | 'E_BAD_PDF' | 'E_BAD_DOCX' | 'E_NO_TEXT' | 'E_DETACHED';
  constructor(code: ExtractError['code'], message: string) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

/**
 * 从上传的 File 里取字节。
 *
 * 【为什么不是一句 `new Uint8Array(await file.arrayBuffer())`】
 * 实测在 Next 15 生产运行时里，`req.formData()` 返回的 File 背后的 ArrayBuffer
 * 可能已经被框架 detach 掉了（请求体流被消费）。这时 `file.arrayBuffer()` 拿到的
 * 是一个 detached buffer，`new Uint8Array(它)` 直接抛
 * `TypeError: Cannot perform Construct on a detached ArrayBuffer`。
 * 更糟的是这行如果写在 try 之外，异常会穿透到框架层，客户端收到的是**空响应体**，
 * 前端连错误提示都显示不出来——静默失败，最难查的一类。
 *
 * 所以这里给三条退路，并按「最不容易踩坑」的顺序排：
 *   1) Blob.bytes()      —— Node 22.13+ 直接返回 Uint8Array，不经过 ArrayBuffer 中转
 *   2) arrayBuffer()     —— 常规路径
 *   3) new Response(f).arrayBuffer() —— 让 fetch 规范自己把 Blob 读出来，绕开 detached 状态
 * 三条全挂才报 E_DETACHED，绝不返回空响应。
 */
export async function bytesOf(file: File): Promise<Uint8Array> {
  // 记录每条退路各自的失败原因：三条都挂时把它们一起报出来，
  // 否则运维只会看到一句「读不出来」，下次还得再来一遍。
  const why: string[] = [];

  const bytesFn = (file as unknown as { bytes?: () => Promise<Uint8Array> }).bytes;
  if (typeof bytesFn === 'function') {
    try {
      const u8 = await bytesFn.call(file);
      if (u8.length > 0) return u8;
      why.push('bytes() 返回空');
    } catch (e) {
      why.push(`bytes() ${(e as Error).message}`);
    }
  } else {
    why.push('无 bytes()');
  }

  try {
    const ab = await file.arrayBuffer();
    if (!ab.detached && ab.byteLength > 0) return new Uint8Array(ab);
    why.push(`arrayBuffer() byteLength=${ab.byteLength} detached=${ab.detached}`);
  } catch (e) {
    why.push(`arrayBuffer() ${(e as Error).message}`);
  }

  try {
    const ab = await new Response(file).arrayBuffer();
    if (ab.byteLength > 0) return new Uint8Array(ab);
    why.push('Response() 返回空');
  } catch (e) {
    why.push(`Response() ${(e as Error).message}`);
  }

  throw new ExtractError(
    'E_DETACHED',
    `接收到的文件内容无法读取（${why.join('；')}）。请重试一次；若仍失败，换用更小的文件。`,
  );
}

export type ExtractResult = {
  mode: DocMode;
  density: DocDensity;
  pages: number | null;
  chars: number;
  blocks: Block[];
};

/** 图片型 PDF 的判定阈值：整篇不足 20 字，说明没有文本层（扫描件/纯截图导出） */
const MIN_TEXT_CHARS = 20;

/** PDF：逐页取文本 → 聚行 → 清洗 → 去页眉页脚 → 切块 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  // 动态 import：pdfjs 是 serverExternalPackages，只在服务端按需加载，
  // 也避免 Next 在构建期就把这个大包打进客户端图。
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let doc;
  try {
    doc = await getDocument({
      data: bytes,
      useSystemFonts: true, // 不依赖打包字体
      isEvalSupported: false, // 关掉 eval（安全基线）
      disableFontFace: true, // Node 无 DOM，不做字体渲染
      verbosity: 0, // 静音 pdfjs 的 warn
    }).promise;
  } catch (e) {
    throw new ExtractError('E_BAD_PDF', `PDF 打不开，文件可能已损坏或被加密：${(e as Error).message}`);
  }

  const pageParagraphs: Array<{ page: number; paragraphs: string[] }> = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // pdfjs 的 item 联合类型里，只有带 str 的才是文字，其余（图片标记等）跳过
    const textItems = (tc.items as Array<{ str?: string; transform?: number[] }>)
      .filter((i) => typeof i.str === 'string' && i.str.length > 0)
      .map((i) => ({ str: i.str as string, transform: i.transform ?? [1, 0, 0, 1, 0, 0] }));
    pageParagraphs.push({ page: p, paragraphs: cleanParagraphs(itemsToParagraphs(textItems)) });
  }

  const chars = pageParagraphs.reduce(
    (s, x) => s + x.paragraphs.reduce((a, p) => a + p.length, 0),
    0,
  );

  // 文本层几乎是空的 → 扫描件。不硬做 OCR（选型时明确砍掉），直接给可读错误。
  if (chars < MIN_TEXT_CHARS) {
    throw new ExtractError(
      'E_EMPTY_PDF',
      `这份 PDF 里几乎没有文字（共 ${chars} 字），应该是扫描件或图片导出的。本作品不做 OCR：请换一份带文本层的 PDF，或用 Word 重新导出。`,
    );
  }

  const deduped = dropRunningHeads(pageParagraphs);
  const blocks = pagesToBlocks(deduped);

  return {
    mode: 'paged',
    density: densityOf(blocks),
    pages: doc.numPages,
    chars,
    blocks,
  };
}

/** DOCX：mammoth 取纯文本 → 按空行/段落切 → 切块（page=null） */
export async function extractDocx(bytes: Uint8Array): Promise<ExtractResult> {
  const mammoth = await import('mammoth');
  let text: string;
  try {
    const out = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    text = out.value ?? '';
  } catch (e) {
    throw new ExtractError('E_BAD_DOCX', `DOCX 打不开，文件可能已损坏：${(e as Error).message}`);
  }

  // extractRawText 用空行分段；有些文档只有单换行，两种都当段落分隔
  const paragraphs = cleanParagraphs(text.split(/\r?\n/));

  if (paragraphs.length === 0) {
    throw new ExtractError('E_NO_TEXT', '这份 DOCX 里没有可提取的文字（可能全是图片或表格）。');
  }

  const blocks = paragraphsToBlocks(paragraphs);
  const chars = paragraphs.reduce((s, p) => s + p.length, 0);

  return {
    mode: 'flow', // DOCX 没有物理页
    density: densityOf(blocks),
    pages: null,
    chars,
    blocks,
  };
}

/** 统一入口：按 kind 分派。调用方负责 S1 校验，这里假定文件已经合法。 */
export async function extract(kind: 'pdf' | 'docx', bytes: Uint8Array): Promise<ExtractResult> {
  return kind === 'pdf' ? extractPdf(bytes) : extractDocx(bytes);
}

/** 落盘后按 path 读回再解析（上传流程用这个，避免把 20MB buffer 在内存里多留一份） */
export async function extractFromFile(
  filePath: string,
  kind: 'pdf' | 'docx',
): Promise<ExtractResult> {
  const bytes = new Uint8Array(await fs.readFile(filePath));
  return extract(kind, bytes);
}

/** 把 Block[] 摊平成便于落库的行（char_len 预先算好，省得每次查询都算） */
export function toBlockRows(docId: string, blocks: Block[]) {
  return blocks.map((b) => ({
    id: `${docId}_${b.idx}`,
    doc_id: docId,
    idx: b.idx,
    page: b.page,
    section: b.section,
    text: b.text,
    char_len: b.text.length,
  }));
}

export { statsOf };
