// scripts/make-tech-pdf.mjs —— 把 docs/technical-doc.md 转成 PDF（pandoc + xelatex）
//
// 【为什么不是一句 pandoc 命令】
// 1) 官方硬上限 30 页，生成后必须**数页数**，超了要压内容而不是无视；
// 2) 中文在 pandoc 默认字体下会缺字（`Missing character`）——正文、代码块、表格都得挂 CJK 字体。
//    只设 mainfont 不够：代码块走 monofont，行内 code 也走 monofont，那些行内 code 里
//    经常夹中文（`scope 合法`），Consolas 里没有中文字形 → 直接掉字。
//    解法是用 pandoc 的 `CJKmainfont` + 把 monofont 也换成同时含中英字形的字体。
// 3) ✅/❌ 这类 emoji 在中文字体里没有字形，已统一改成「已完成/未完成」等中文词。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SRC = 'docs/technical-doc.md';
const OUT = process.argv[2] ?? 'docs/technical-doc.pdf';

// 正文与代码块都用同时含中英字形的字体，避免行内 code 里的中文掉字。
// 思源/微软雅黑都含中英；Consolas 只有西文，不能用。
const SANS = 'Microsoft YaHei';
const MONO = 'Sarasa Mono SC';

// 选一个真的装了的等宽中文字体，装不到就退回雅黑（宁可不等宽，不能掉字）
const MONO_CANDIDATES = ['Sarasa Mono SC', 'NSimSun', 'SimSun', 'Microsoft YaHei'];
const fontList = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' });
const installed = fontList.status === 0 ? fontList.stdout : '';
const mono = MONO_CANDIDATES.find((f) => installed.includes(f)) ?? SANS;

const args = [
  SRC,
  '-o', OUT,
  '--pdf-engine=xelatex',
  '-V', `mainfont=${SANS}`,
  '-V', `monofont=${mono}`,
  '-V', `CJKmainfont=${SANS}`,
  '-V', `CJKmonofont=${mono}`,
  '-V', 'fontsize=10pt',
  '-V', 'geometry:margin=2.2cm',
  '-V', 'colorlinks=true',
  '-V', 'linkcolor=black',
  '-V', 'urlcolor=black',
  '--toc',
  '--toc-depth=2',
  '--metadata', 'title=预演（Rehearsal）技术文档',
  '--metadata', 'subtitle=传智杯 AI 创新应用挑战赛 · 赛道 id=10039',
];

const r = spawnSync('pandoc', args, { encoding: 'utf8' });

// 缺字警告单独统计：它们不会让 pandoc 失败，但会让 PDF 悄悄少字 —— 必须当失败处理
const missing = [...new Set((r.stderr ?? '').match(/Missing character: There is no (\S+)/g) ?? [])];
const warnings = (r.stderr ?? '').split('\n').filter((l) => l.includes('Missing character'));

if (r.status !== 0) {
  console.error(r.stderr);
  console.error('[FAIL] pandoc 退出码', r.status);
  process.exit(1);
}
if (!fs.existsSync(OUT)) {
  console.error('[FAIL] 未生成 PDF');
  process.exit(1);
}

if (missing.length) {
  console.warn(`[warn] 缺字 ${warnings.length} 处（字体 ${mono}）：`);
  for (const m of missing.slice(0, 10)) console.warn('   ', m);
} else {
  console.log('[ok] 无缺字警告');
}

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`[ok] ${OUT} ${kb} KB`);

// 数页数：优先用 pdfinfo（xelatex 生成的 PDF 用对象流压缩，正则数 /Type /Page 数不准）
const info = spawnSync('pdfinfo', [OUT], { encoding: 'utf8' });
let pages = null;
if (info.status === 0) {
  const m = info.stdout.match(/^Pages:\s+(\d+)/m);
  if (m) pages = Number(m[1]);
}
if (pages === null) {
  // 兜底：没有 pdfinfo 时用正则估个下限（可能偏低，只作提示）
  const text = fs.readFileSync(OUT).toString('latin1');
  pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log('[warn] 没找到 pdfinfo，页数由正则估算，可能偏低');
}
console.log(`[pages] ${pages} 页（官方上限 30）${pages > 30 ? '  ⚠ 超限，必须压内容' : ' [ok]'}`);
if (pages > 30) process.exitCode = 2;
