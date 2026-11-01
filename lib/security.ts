// lib/security.ts —— 安全基线 S1：上传白名单 + 体积上限（纯函数，不碰文件系统与 DB）
//
// 三道闸，顺序是有讲究的：
//   1) 扩展名白名单  —— 最便宜的拒绝，先挡掉 99% 垃圾
//   2) 声明 MIME 白名单 —— 挡住「浏览器/脚本声称错的类型」
//   3) 文件头魔数    —— 最后一道，并且**必须与扩展名一致**
// 只有第 3 道是骗不过去的：扩展名和 MIME 都是上传方自己写的，魔数是文件内容自己带的。
// 所以魔数不一致时一律拒绝（例如把 .exe 改名成 .pdf），不做「以魔数为准就放行」的宽容处理。
//
// S2 一并落在这里：落盘名只由服务端 uuid 生成，用户文件名只能进 DB 当展示名，绝不参与路径。

import { randomUUID } from 'node:crypto';

/** 20MB：单页论文远小于此，超过必然是误选文件或恶意载荷 */
export const MAX_BYTES = 20 * 1024 * 1024;

export type DocKind = 'pdf' | 'docx';

type Spec = {
  kind: DocKind;
  ext: string;
  /** 允许声明的 MIME；octet-stream 视为「未声明」，交给魔数裁决 */
  mimes: string[];
  /** 文件头字节（可多种合法变体） */
  magics: number[][];
};

/**
 * 白名单只有两种。**PPTX 明确不做**（v2.1.2）：
 * 解析需要 officeparser/JSZip 全套 + 大量版式噪声，性价比低，且本作品语料是论文/项目文档/简历。
 */
const SPECS: Spec[] = [
  {
    kind: 'pdf',
    ext: '.pdf',
    mimes: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
    magics: [[0x25, 0x50, 0x44, 0x46]], // "%PDF"
  },
  {
    kind: 'docx',
    ext: '.docx',
    mimes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
    ],
    // docx 是 zip 容器：PK\x03\x04 正常 / PK\x05\x06 空包 / PK\x07\x08 分卷
    magics: [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
      [0x50, 0x4b, 0x07, 0x08],
    ],
  },
];

export type UploadErrorCode =
  | 'E_EXT'
  | 'E_MIME'
  | 'E_MAGIC'
  | 'E_MISMATCH'
  | 'E_SIZE'
  | 'E_EMPTY';

export type UploadCheck =
  | { ok: true; kind: DocKind; ext: string }
  | { ok: false; code: UploadErrorCode; message: string };

/** 从文件名取扩展名（小写）。只看最后一段扩展名，不猜内容。 */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/** 扩展名 → 种类；不在白名单返回 null */
export function kindOfName(name: string): DocKind | null {
  const ext = extOf(name);
  const spec = SPECS.find((s) => s.ext === ext);
  return spec ? spec.kind : null;
}

/** 文件头 → 种类；魔数对不上返回 null（这是唯一骗不过去的判定） */
export function sniffKind(bytes: Uint8Array): DocKind | null {
  for (const spec of SPECS) {
    for (const magic of spec.magics) {
      if (bytes.length < magic.length) continue;
      if (magic.every((b, i) => bytes[i] === b)) return spec.kind;
    }
  }
  return null;
}

/**
 * 识别「已知的非白名单格式」的文件头。
 *
 * 【为什么需要它 —— 这是 E_MISMATCH 永远走不到的那个分支】
 * 之前 E_MISMATCH 只会在「扩展名 pdf + 内容其实是 docx（zip 头）」时触发，
 * 因为 sniffKind 只认白名单里的两种格式。而最典型的攻击
 * ——把 .exe 改名成 .pdf——sniffKind 返回 null，直接落到 E_MAGIC，
 * 用户看到的是"文件可能已损坏"，而真实情况是"你改过扩展名"。
 * 拒绝理由说错，和安全没做是两回事：前者会让用户反复重传一个永远传不上的文件。
 *
 * 这张表只用于**生成更准确的拒绝理由**，绝不用于放行任何东西。
 */
const FOREIGN_MAGICS: Array<{ label: string; bytes: number[] }> = [
  { label: 'EXE/DLL', bytes: [0x4d, 0x5a] }, // MZ
  { label: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { label: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
  { label: 'ZIP/RAR 等压缩包', bytes: [0x52, 0x61, 0x72, 0x21] }, // Rar!
  { label: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { label: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

/** 已知的外部格式名（用于更准确的拒绝理由）；不认识返回 null */
export function foreignKindOf(bytes: Uint8Array): string | null {
  for (const f of FOREIGN_MAGICS) {
    if (bytes.length < f.bytes.length) continue;
    if (f.bytes.every((b, i) => bytes[i] === b)) return f.label;
  }
  return null;
}

/**
 * S1 总闸。`bytes` 只需要前若干字节（路由层读满即可，20MB 内存无压力）。
 *
 * 判定顺序：体积 → 扩展名 → MIME → 魔数 → 扩展名与魔数是否一致。
 * 不一致单独给 E_MISMATCH 而不是直接 E_MAGIC，是为了让用户看懂「你改过扩展名」。
 */
export function checkUpload(input: {
  name: string;
  type?: string;
  size: number;
  bytes: Uint8Array;
}): UploadCheck {
  const { name, type = '', size, bytes } = input;

  if (size <= 0 || bytes.length === 0) {
    return { ok: false, code: 'E_EMPTY', message: '文件是空的，换个文件再试。' };
  }
  if (size > MAX_BYTES) {
    return {
      ok: false,
      code: 'E_SIZE',
      message: `文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限，请压缩或换一份更小的材料。`,
    };
  }

  const byExt = kindOfName(name);
  if (!byExt) {
    return {
      ok: false,
      code: 'E_EXT',
      message: '只支持 PDF 和 DOCX。PPTX 暂不支持——请把关键内容导出成 PDF 再上传。',
    };
  }

  const spec = SPECS.find((s) => s.kind === byExt)!;
  const declared = type.split(';')[0].trim().toLowerCase();
  if (declared && !spec.mimes.includes(declared)) {
    return {
      ok: false,
      code: 'E_MIME',
      message: `文件类型声明为 ${declared}，与扩展名 ${spec.ext} 不符，已拒绝。`,
    };
  }

  const byMagic = sniffKind(bytes);
  if (!byMagic) {
    // 【先查"是不是一个已知的别的格式"】这决定用户看到哪一句话。
    // "文件可能已损坏"会让用户一遍遍重传同一个文件；
    // "你上传的其实是一个 EXE"才会让他明白问题在哪。
    const foreign = foreignKindOf(bytes);
    if (foreign) {
      return {
        ok: false,
        code: 'E_MISMATCH',
        message: `文件扩展名是 ${spec.ext}，但内容实际是 ${foreign}，已拒绝。请上传真正的 ${spec.ext.toUpperCase()} 文件。`,
      };
    }
    return {
      ok: false,
      code: 'E_MAGIC',
      message: `文件内容不是合法的 ${spec.ext}（文件头校验未通过），可能已损坏或并非该格式。`,
    };
  }
  if (byMagic !== byExt) {
    return {
      ok: false,
      code: 'E_MISMATCH',
      message: `文件扩展名是 ${spec.ext}，但内容实际是 ${byMagic.toUpperCase()}，已拒绝。`,
    };
  }

  return { ok: true, kind: byExt, ext: spec.ext };
}

/**
 * S2：落盘名 = 服务端 uuid + 白名单扩展名。
 * 用户文件名永不进路径（哪怕是 `../../etc/passwd.pdf` 也只能得到 `uuid.pdf`）。
 */
export function safeUploadName(kind: DocKind, id: string = randomUUID()): string {
  const spec = SPECS.find((s) => s.kind === kind)!;
  return `${id}${spec.ext}`;
}

/** 展示用：文件名截断到 80 字，去掉控制字符与路径分隔符（DB 里只当文本存） */
export function displayNameOf(name: string, max = 80): string {
  const cleaned = name.replace(/[\u0000-\u001F\u007F]/g, '').replace(/[\\/]/g, '_').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned || '未命名材料';
}
