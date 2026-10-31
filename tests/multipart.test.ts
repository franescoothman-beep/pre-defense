import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryOf, parseMultipartFile } from '../lib/multipart.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 构造一个浏览器会发出的 multipart body（含一个文本字段 + 一个文件字段） */
function buildBody(boundary: string, fileBytes: Uint8Array, filename = 'a.pdf', type = 'application/pdf') {
  const parts: string[] = [];
  parts.push(`--${boundary}\r\n`);
  parts.push('Content-Disposition: form-data; name="note"\r\n\r\n');
  parts.push('hello\r\n');
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
  parts.push(`Content-Type: ${type}\r\n\r\n`);
  return { prefix: enc.encode(parts.join('')), suffix: enc.encode(`\r\n--${boundary}--\r\n`), fileBytes };
}

function concat(prefix: Uint8Array, mid: Uint8Array, suffix: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + mid.length + suffix.length);
  out.set(prefix, 0);
  out.set(mid, prefix.length);
  out.set(suffix, prefix.length + mid.length);
  return out;
}

test('boundaryOf：带引号 / 不带引号 / 缺失', () => {
  assert.equal(boundaryOf('multipart/form-data; boundary="abc123"'), 'abc123');
  assert.equal(boundaryOf('multipart/form-data; boundary=abc123'), 'abc123');
  assert.equal(boundaryOf('multipart/form-data'), null);
  assert.equal(boundaryOf(null), null);
});

test('parseMultipartFile：取出文件字节，逐字节与原文一致', () => {
  const boundary = '----WebKitFormBoundaryTEST';
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0xfe]);
  const b = buildBody(boundary, pdf);
  const body = concat(b.prefix, b.fileBytes, b.suffix);

  const got = parseMultipartFile(body, boundary);
  assert.ok(got, '应取到文件 part');
  assert.equal(got.filename, 'a.pdf');
  assert.equal(got.contentType, 'application/pdf');
  assert.equal(got.bytes.length, pdf.length, '长度必须与原文一致（不能多吃或少吃 CRLF）');
  assert.deepEqual([...got.bytes], [...pdf], '逐字节必须一致');
});

test('parseMultipartFile：二进制内容（含 0x00 / 高位字节）不被破坏', () => {
  const boundary = 'xyz';
  const bin = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bin[i] = i;
  const b = buildBody(boundary, bin);
  const body = concat(b.prefix, b.fileBytes, b.suffix);
  const got = parseMultipartFile(body, boundary);
  assert.ok(got);
  assert.equal(got.bytes.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(got.bytes[i], i, `第 ${i} 字节`);
});

test('parseMultipartFile：文件名带路径/控制字符时原样回传（由上层再净化）', () => {
  const boundary = 'b1';
  const data = enc.encode('%PDF-1.7');
  const b = buildBody(boundary, data, '../../etc/passwd.pdf');
  const body = concat(b.prefix, b.fileBytes, b.suffix);
  const got = parseMultipartFile(body, boundary);
  assert.ok(got);
  assert.equal(got.filename, '../../etc/passwd.pdf');
});

test('parseMultipartFile：字段名不是 file → 返回 null（不静默接手别的字段）', () => {
  const boundary = 'b2';
  const data = enc.encode('hello');
  const b = buildBody(boundary, data, 'a.pdf', '');
  const body = concat(b.prefix, b.fileBytes, b.suffix);
  const got = parseMultipartFile(body, boundary, 'other');
  assert.equal(got, null);
});

test('parseMultipartFile：空内容 → null（不是合法的上传）', () => {
  const boundary = 'b3';
  const b = buildBody(boundary, new Uint8Array(0));
  const body = concat(b.prefix, b.fileBytes, b.suffix);
  assert.equal(parseMultipartFile(body, boundary), null);
});

test('parseMultipartFile：boundary 不存在 / body 截断 → null（不抛异常）', () => {
  const body = enc.encode('--garbage--\r\n\r\nxx');
  assert.equal(parseMultipartFile(body, 'nothere'), null);
  const truncated = enc.encode('--b\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n%PDF');
  assert.equal(parseMultipartFile(truncated, 'b'), null, '没有结束边界时不能返回半个文件');
});

test('parseMultipartFile：中文文件名', () => {
  const boundary = 'b4';
  const data = enc.encode('%PDF-1.7');
  const b = buildBody(boundary, data, '论文终稿.pdf');
  const body = concat(b.prefix, b.fileBytes, b.suffix);
  const got = parseMultipartFile(body, boundary);
  assert.ok(got);
  assert.equal(got.filename, '论文终稿.pdf');
  assert.equal(dec.decode(got.bytes), '%PDF-1.7');
});
