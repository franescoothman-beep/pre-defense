// scripts/pdf-pages.mjs —— 把 PDF 指定页渲染成 PNG，用于目视排版检查
// 用法: node scripts/pdf-pages.mjs <pdf> <outPrefix> <from> <to> [dpi]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [pdf, prefix, from = '1', to = '1', dpi = '90'] = process.argv.slice(2);
if (!pdf || !prefix) {
  console.error('用法: node scripts/pdf-pages.mjs <pdf> <outPrefix> <from> <to> [dpi]');
  process.exit(1);
}
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const r = spawnSync('pdftoppm', ['-png', '-r', dpi, '-f', from, '-l', to, pdf, prefix], {
  encoding: 'utf8',
});
if (r.status !== 0) {
  console.error(r.stderr || '[FAIL] pdftoppm 失败');
  process.exit(1);
}
for (const f of fs.readdirSync(path.dirname(prefix))) {
  if (f.startsWith(path.basename(prefix)) && f.endsWith('.png')) {
    const p = path.join(path.dirname(prefix), f);
    console.log(p, Math.round(fs.statSync(p).size / 1024) + 'KB');
  }
}
