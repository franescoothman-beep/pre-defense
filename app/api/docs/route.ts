// app/api/docs/route.ts —— 上传（POST）与材料列表（GET）
//
// POST 流程：原始请求体 → 自解析 multipart → S1 校验 → 解析（内存）→ uuid 落盘 → 写库（事务）
// GET  流程：只读 documents，按创建时间倒序，供上传页展示"已解析的材料"
//
// 路由层只做三件事：读入参 → 调 lib → 组装响应。业务判断一律在 lib/。
//
// 【为什么不用 req.formData()】见 lib/multipart.ts 顶部注释：
// Next 15 生产模式下，formData() 之后 File 的 ArrayBuffer 可能已被 detach，
// 6MB 以上的 PDF 必挂 `Cannot perform Construct on a detached ArrayBuffer`，
// 且该异常会穿透 route 的 try，客户端收到空响应体。改为直接读原始 body 字节。

import path from 'node:path';
import fs from 'node:fs/promises';
import { checkUpload, safeUploadName, displayNameOf, MAX_BYTES } from '@/lib/security';
import { extract, toBlockRows, ExtractError } from '@/lib/extract';
import { boundaryOf, parseMultipartFile } from '@/lib/multipart';
import { q, tx } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

export async function GET() {
  const docs = q.all(
    `select id, name, pages, chars, mode, density, created_at
     from documents order by created_at desc limit 20`,
  );
  return Response.json({ ok: true, docs });
}

/** 统一的失败响应：**永远返回 JSON**，绝不出现空响应体 */
function fail(code: string, message: string, status: number) {
  return Response.json({ ok: false, code, message }, { status });
}

/** 读原始请求体字节（不经过 formData，避开 detached ArrayBuffer） */
class TooLargeError extends Error {
  code = 'E_SIZE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

async function rawBody(req: Request): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const r = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      // 边读边限流：不要等读完 20MB 才发现超限
      if (total > MAX_BYTES + 1024 * 1024) {
        await r.cancel();
        throw new TooLargeError(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限。`);
      }
    }
  } finally {
    r.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function POST(req: Request) {
  try {
    return await handleUpload(req);
  } catch (e) {
    // 最外层兜底：任何没被预料到的异常也必须是可读 JSON（否则前端只能显示"未知错误"）
    console.error('[POST /api/docs]', e);
    const msg = e instanceof ExtractError ? e.message : '上传时出现意外错误，请重试。';
    return fail(e instanceof ExtractError ? e.code : 'E_INTERNAL', msg, 500);
  }
}

async function handleUpload(req: Request): Promise<Response> {
  const ct = req.headers.get('content-type');
  const boundary = boundaryOf(ct);
  if (!boundary) {
    return fail('E_FORM', '请求格式有误，需要 multipart 上传。', 400);
  }

  let raw: Uint8Array;
  try {
    raw = await rawBody(req);
  } catch (e) {
    if (e instanceof TooLargeError) return fail(e.code, e.message, 413);
    throw e;
  }

  const part = parseMultipartFile(raw, boundary, 'file');
  if (!part) {
    return fail('E_NOFILE', '没有收到文件，或文件为空。', 400);
  }

  if (part.bytes.length > MAX_BYTES) {
    return fail('E_SIZE', `文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限。`, 413);
  }

  const check = checkUpload({
    name: part.filename || 'upload.pdf',
    type: part.contentType,
    size: part.bytes.length,
    bytes: part.bytes,
  });
  if (!check.ok) {
    // 4xx 而不是 500：这是用户可修正的问题，不是服务故障
    return fail(check.code, check.message, 400);
  }

  // 先在内存里解析：解析不出来的文件根本不该落盘，避免堆一堆没用的孤儿文件
  let parsed;
  try {
    parsed = await extract(check.kind, part.bytes);
  } catch (e) {
    if (e instanceof ExtractError) return fail(e.code, e.message, 422);
    console.error('[extract]', e);
    return fail('E_PARSE', '解析时出现意外错误，请换一份文件再试。', 500);
  }

  // S2：落盘名只由服务端 uuid 生成，用户文件名只作为展示名进库
  const docId = crypto.randomUUID();
  const storedName = safeUploadName(check.kind, docId);
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, storedName), part.bytes);

  const now = new Date().toISOString();
  const displayName = displayNameOf(part.filename || '未命名材料');
  const rows = toBlockRows(docId, parsed.blocks);

  // 材料 + 全部文本块必须原子落库：只写进 documents 而块没了，
  // 后面所有 claim 的 block_idx 都会指向空——这种半成品数据比没有更糟。
  tx(() => {
    q.run(
      `insert into documents(id, name, path, pages, chars, mode, density, status, created_at)
       values(?,?,?,?,?,?,?,?,?)`,
      docId,
      displayName,
      storedName,
      parsed.pages,
      parsed.chars,
      parsed.mode,
      parsed.density,
      'parsed',
      now,
    );

    for (const r of rows) {
      q.run(
        `insert into blocks(id, doc_id, idx, page, section, text, char_len) values(?,?,?,?,?,?,?)`,
        r.id,
        r.doc_id,
        r.idx,
        r.page,
        r.section,
        r.text,
        r.char_len,
      );
    }
  });

  return Response.json({
    ok: true,
    docId,
    name: displayName,
    pages: parsed.pages,
    chars: parsed.chars,
    mode: parsed.mode,
    density: parsed.density,
    blocks: rows.length,
    // 上传页只显示前 3 块预览，不把 2400 块全塞进响应
    preview: rows.slice(0, 3).map((b) => ({
      idx: b.idx,
      page: b.page,
      section: b.section,
      text: b.text.length > 120 ? b.text.slice(0, 120) + '…' : b.text,
    })),
  });
}
