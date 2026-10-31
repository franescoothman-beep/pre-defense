import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BYTES,
  checkUpload,
  safeUploadName,
  sniffKind,
  kindOfName,
  displayNameOf,
} from '../lib/security.ts';

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const DOCX_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const EXE_HEAD = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

function pad(head: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(head, 0);
  return out;
}

test('checkUpload：合法 PDF 通过', () => {
  const r = checkUpload({
    name: '论文.pdf',
    type: 'application/pdf',
    size: 1024,
    bytes: pad(PDF_HEAD, 1024),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.kind, 'pdf');
});

test('checkUpload：合法 DOCX 通过，且 octet-stream（未声明 MIME）放行给魔数裁决', () => {
  const r = checkUpload({
    name: '简历.docx',
    type: 'application/octet-stream',
    size: 1024,
    bytes: pad(DOCX_HEAD, 1024),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.kind, 'docx');
});

test('checkUpload：PPTX / .exe / 无扩展名 全部按扩展名白名单拒绝', () => {
  for (const name of ['讲稿.pptx', 'tool.exe', 'noext', '论文.PDF.zip']) {
    const r = checkUpload({ name, type: '', size: 1024, bytes: pad(PDF_HEAD, 1024) });
    assert.equal(r.ok, false, `${name} 应被拒绝`);
    if (!r.ok) assert.equal(r.code, 'E_EXT');
  }
});

test('checkUpload：扩展名大小写不敏感（.PDF 是合法 pdf）', () => {
  const r = checkUpload({ name: '论文.PDF', type: '', size: 1024, bytes: pad(PDF_HEAD, 1024) });
  assert.equal(r.ok, true);
});

test('checkUpload：超过 20MB 拒绝', () => {
  const r = checkUpload({
    name: '大文件.pdf',
    type: 'application/pdf',
    size: MAX_BYTES + 1,
    bytes: PDF_HEAD,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'E_SIZE');
});

test('checkUpload：空文件拒绝', () => {
  const r = checkUpload({ name: '空.pdf', type: 'application/pdf', size: 0, bytes: new Uint8Array(0) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'E_EMPTY');
});

test('checkUpload：MIME 声明与扩展名不符 → E_MIME', () => {
  const r = checkUpload({
    name: '论文.pdf',
    type: 'image/png',
    size: 1024,
    bytes: pad(PDF_HEAD, 1024),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'E_MIME');
});

test('checkUpload：文件头不是 PDF → E_MAGIC（改名骗不过去）', () => {
  const r = checkUpload({
    name: '论文.pdf',
    type: 'application/pdf',
    size: 1024,
    bytes: pad(EXE_HEAD, 1024),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'E_MAGIC');
    assert.match(r.message, /文件头/);
  }
});

test('checkUpload：扩展名与魔数不一致 → E_MISMATCH（docx 内容改名成 pdf）', () => {
  const r = checkUpload({
    name: '冒充.pdf',
    type: 'application/pdf',
    size: 1024,
    bytes: pad(DOCX_HEAD, 1024),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'E_MISMATCH');
    assert.match(r.message, /实际是 DOCX/);
  }
});

test('sniffKind：三种 zip 变体都识别为 docx，未知头返回 null', () => {
  assert.equal(sniffKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'docx');
  assert.equal(sniffKind(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), 'docx');
  assert.equal(sniffKind(new Uint8Array([0x50, 0x4b, 0x07, 0x08])), 'docx');
  assert.equal(sniffKind(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(sniffKind(new Uint8Array(0)), null);
});

test('kindOfName：只认白名单后缀', () => {
  assert.equal(kindOfName('a.pdf'), 'pdf');
  assert.equal(kindOfName('a.docx'), 'docx');
  assert.equal(kindOfName('a.doc'), null, '旧版 .doc 不支持');
  assert.equal(kindOfName('a.txt'), null);
  assert.equal(kindOfName('a'), null);
});

test('safeUploadName：S2 用户文件名永不进路径', () => {
  const name = safeUploadName('pdf', 'abc-123');
  assert.equal(name, 'abc-123.pdf');
  // 恶意原名完全不参与
  const evil = safeUploadName('docx');
  assert.match(evil, /^[0-9a-f-]{36}\.docx$/, '不含 uuid 以外的任何字符');
});

test('displayNameOf：去控制字符与路径分隔符，超长截断', () => {
  assert.equal(displayNameOf('..\\..\\etc\\passwd.pdf'), '.._.._etc_passwd.pdf');
  assert.equal(displayNameOf('a\u0000b.docx'), 'ab.docx');
  assert.equal(displayNameOf('   '), '未命名材料');
  assert.equal(displayNameOf('x'.repeat(120)).length, 80);
});
