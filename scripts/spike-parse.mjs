// scripts/spike-parse.mjs —— 阶段 0 解析 spike（一次性验证脚本，不进产品代码）
// 目标：确认 pdfjs-dist 能否逐页给出「干净的中文文本」，页号是否可信，
//      以及「不装 @napi-rs/canvas（原生 38MB）」时是否仍能完成文本提取
// 用法：node scripts/spike-parse.mjs "<pdf 路径>"
import './polyfill-canvas.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/spike-parse.mjs <pdf>'); process.exit(1); }

const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({
  data,
  useSystemFonts: true,      // 不依赖打包字体
  isEvalSupported: false,     // 关掉 eval（安全基线）
  disableFontFace: true,      // Node 无 DOM，不做字体渲染
  verbosity: 0,               // 静音 "Cannot load @napi-rs/canvas" 之类的 warn
}).promise;

console.log('='.repeat(70));
console.log('文件:', path.basename(file));
console.log('页数:', doc.numPages);
console.log('='.repeat(70));

/**
 * 关键：中文 PDF 常把每个字作为一个 item，且 y 坐标有微小抖动。
 * 聚行策略 = 按 y 容差 2.5 分行 + 同行内按 x 排序 + 去掉「逐字空格化」造成的假空格。
 */
function itemsToText(items) {
  const glyphs = items.filter((i) => typeof i.str === 'string');
  const rows = [];
  for (const it of glyphs) {
    const x = it.transform[4], y = it.transform[5];
    const row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
    if (row) row.items.push({ x, s: it.str });
    else rows.push({ y, items: [{ x, s: it.str }] });
  }
  rows.sort((a, b) => b.y - a.y); // PDF 坐标 y 向下递减
  return rows
    .map((r) => {
      const s = r.items.sort((a, b) => a.x - b.x).map((i) => i.s).join('');
      // 逐字空格化：单个汉字之间被插入了空格 → 全部还原
      return s.replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '');
    })
    .join('\n')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = itemsToText(tc.items);

  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]/g) || []).length;
  const pua = (text.match(/[\uE000-\uF8FF]/g) || []).length;
  const repl = (text.match(/\uFFFD/g) || []).length;
  const fleshy = (text.match(/(?<=[\u4e00-\u9fa5]) (?=[\u4e00-\u9fa5])/g) || []).length; // 残留汉字间空格

  pages.push({ p, text, cjk, latin, pua, repl, fleshy });

  console.log(`\n--- P${p} · 字符 ${text.length} · 汉字 ${cjk} · 拉丁 ${latin} · 私用区 ${pua} · 替换符 ${repl} · 汉字间空格 ${fleshy} ---`);
  console.log(text.slice(0, 220).replace(/\n/g, ' ⏎ ') + (text.length > 220 ? ' …' : ''));
}

const total = pages.reduce((s, x) => s + x.text.length, 0);
const empty = pages.filter((x) => x.text.length < 20).length;
const bad = pages.reduce((s, x) => s + x.pua + x.repl, 0);

console.log('\n' + '='.repeat(70));
console.log('汇总');
console.log('  总字符数 :', total);
console.log('  空页(<20字) :', empty);
console.log('  乱码字符(私用区+替换符) :', bad);
console.log('  原生依赖 : 未安装 @napi-rs/canvas，仅用 polyfill');
console.log('  判定 :', total > 0 && empty === 0 && bad / Math.max(total, 1) < 0.02
  ? '✅ 文本层可提取 → mode=paged（page 有值）'
  : '⚠️ 文本层不可靠 → mode=flow（page=NULL，靠 section+quote）');
console.log('='.repeat(70));
