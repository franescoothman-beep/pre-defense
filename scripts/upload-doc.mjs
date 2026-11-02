/**
 * 上传一份材料并等抽取完成，打印 docId / blocks / claims 概况。
 * 用法：node scripts/upload-doc.mjs <文件路径>
 */
import { openAsBlob } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/upload-doc.mjs <文件路径>');
  process.exit(1);
}
const abs = path.resolve(file);
const blob = await openAsBlob(abs);
const name = path.basename(abs);
const form = new FormData();
form.append('file', blob, name);

const up = await fetch(`${BASE}/api/docs`, { method: 'POST', body: form });
const upJson = await up.json();
console.log('[upload]', JSON.stringify(upJson).slice(0, 300));
if (!upJson.ok) process.exit(1);
const docId = upJson.docId ?? upJson.id;

// claims 抽取与上传在同一次请求里跑完（route 内部 await），这里只确认条数
const c = await (await fetch(`${BASE}/api/docs/${docId}/claims`)).json();
console.log('[claims]', (c.claims ?? []).length, '条');
console.log(docId);
