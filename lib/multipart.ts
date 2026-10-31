// lib/multipart.ts —— 自己解析 multipart/form-data（纯函数 + 最小流读取）
//
// 【为什么不用 req.formData()】
// 实测（Next 15.5.28 生产模式，6.1MB PDF）：`await req.formData()` 之后，
// File 背后的 ArrayBuffer 会处于 detached 状态；`await file.arrayBuffer()`
// 拿到的就是那个已 detach 的 buffer，`new Uint8Array(它)` 抛
// `TypeError: Cannot perform Construct on a detached ArrayBuffer`。
// 这个异常发生在 Next 的请求体处理管线里，连我们 route 的 try 都接不住，
// 客户端拿到的是**空响应体**（最糟的失败形态：前端连错误都显示不出来）。
//
// 37KB 的 DOCX 不会触发，6.1MB 的 PDF 必挂——说明它跟体积/流回收有关，
// 不是小概率抖动。所以这条路必须绕开：**自己从原始字节里切出文件部分**。
//
// 代价：不做完整的 RFC 7578（不处理嵌套 multipart、不处理 filename* 编码），
// 只处理浏览器 `FormData` 实际会发出的形态。这足够，而且是安全的：
// 我们只按 `name="file"` 精确匹配，其余 part 一律丢弃。

export type MultipartFile = {
  /** 客户端原始文件名（只用于展示，绝不参与路径） */
  filename: string;
  /** 声明的 MIME（可能为空） */
  contentType: string;
  bytes: Uint8Array;
};

/** 从 Content-Type 头里取 boundary */
export function boundaryOf(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const raw = m?.[1] ?? m?.[2];
  return raw ? raw.trim() : null;
}

const CRLF = 13; // \r
const LF = 10; // \n

/** 在 hay[from..] 里找 needle 的起始下标，找不到返回 -1 */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  const limit = hay.length - needle.length;
  for (let i = from; i <= limit; i++) {
    if (hay[i] !== first) continue;
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** 解析单个 part 的头部（只看 content-disposition 与 content-type） */
function parsePartHeaders(raw: string): { name: string; filename: string; contentType: string } {
  let name = '';
  let filename = '';
  let contentType = '';
  for (const line of raw.split('\r\n')) {
    const lower = line.toLowerCase();
    if (lower.startsWith('content-disposition:')) {
      const nm = /name="([^"]*)"/i.exec(line);
      if (nm) name = nm[1];
      const fn = /filename="([^"]*)"/i.exec(line);
      if (fn) filename = fn[1];
    } else if (lower.startsWith('content-type:')) {
      contentType = line.slice(line.indexOf(':') + 1).trim();
    }
  }
  return { name, filename, contentType };
}

/**
 * 从原始请求体字节里取出 `name="file"` 的那一段。
 *
 * 返回 null 表示：没有 boundary / 没找到该字段 / 该字段没有文件内容。
 * 这三种都视为"没收到文件"，由路由层给出可读错误。
 */
export function parseMultipartFile(body: Uint8Array, boundary: string, fieldName = 'file'): MultipartFile | null {
  if (!boundary) return null;

  const dashBoundary = new Uint8Array(`--${boundary}`.split('').map((c) => c.charCodeAt(0)));
  const headerEnd = new Uint8Array([CRLF, LF, CRLF, LF]); // 头部与内容之间空行 = \r\n\r\n
  const dashDash = [45, 45]; // "-" 的字节

  // 游标 = 当前 part 的 "----boundary" 起始下标
  let pos = indexOfBytes(body, dashBoundary, 0);
  if (pos < 0) return null;

  while (pos >= 0) {
    // ① 跳过 "--boundary" 本身
    let cursor = pos + dashBoundary.length;

    // ② 紧随其后只可能是三种：`--`（整体结束）/ CRLF（换行）/ 直接头部（浏览器不会，但容错）
    if (body[cursor] === dashDash[0] && body[cursor + 1] === dashDash[1]) return null;
    while (cursor < body.length && (body[cursor] === CRLF || body[cursor] === LF)) cursor++;

    // ③ 头部结束于空行。**这里不能复用「下一个 boundary」的搜索**：
    //    正文里完全可能出现与 boundary 相似的字节，先把头部边界钉死才安全。
    const headEnd = indexOfBytes(body, headerEnd, cursor);
    if (headEnd < 0) return null;

    // 头部含非 ASCII（中文文件名）时，String.fromCharCode 逐字节拼出来是乱码；
    // 用 TextDecoder 才不会把 UTF-8 的 filename 弄坏。
    const headersText = new TextDecoder('utf-8').decode(body.subarray(cursor, headEnd));
    const h = parsePartHeaders(headersText);

    const contentStart = headEnd + 4; // 跳过整个 \r\n\r\n
    const nextBoundary = indexOfBytes(body, dashBoundary, contentStart);
    if (nextBoundary < 0) return null; // 没有结束边界：body 被截断，绝不返回半个文件

    // ④ 内容尾部自带一个 CRLF（分隔符的换行），必须切掉，否则文件末尾多两个字节
    let contentEnd = nextBoundary;
    if (contentEnd >= 2 && body[contentEnd - 2] === CRLF && body[contentEnd - 1] === LF) contentEnd -= 2;

    if (h.name === fieldName) {
      const bytes = body.subarray(contentStart, contentEnd);
      if (bytes.length === 0) return null;
      return {
        filename: h.filename || '',
        contentType: h.contentType || '',
        bytes,
      };
    }

    pos = nextBoundary; // 换到下一个 part
  }
  return null;
}
