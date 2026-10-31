// scripts/smoke-upload.mjs —— 阶段 1 的端到端验收（真实 HTTP，不 mock）
// 用法：先 `next start -p 3100`，再 `node scripts/smoke-upload.mjs`
//
// 三条 DoD：
//   1) 真实中文论文 PDF → paged，抽查 3 页无乱码
//   2) DOCX → flow，page 为 NULL 且 section 有回填
//   3) 图片型 PDF → 可读错误（422），不是 500
// 外加：无关类型被 S1 拦截；density 正确写入
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

async function up(path, name, type) {
  const body = new FormData();
  const buf = fs.readFileSync(path);
  body.append('file', new Blob([buf], { type }), name ?? path.split(/[\\/]/).pop());
  const r = await fetch(`${BASE}/api/docs`, { method: 'POST', body });
  const j = await r.json();
  return { status: r.status, ...j };
}

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✖ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('=== 1) 真实中文论文 PDF（101 页）===');
const pdf = await up('data/samples/thesis.pdf', '论文终稿.pdf', 'application/pdf');
ok('HTTP 200', pdf.ok === true, `status=${pdf.status}`);
ok('mode=paged', pdf.mode === 'paged');
ok('pages 有值', typeof pdf.pages === 'number' && pdf.pages > 0, `pages=${pdf.pages}`);
ok('blocks 有值', typeof pdf.blocks === 'number' && pdf.blocks > 100, `blocks=${pdf.blocks}`);
ok('density 已写入', ['thin', 'normal', 'heavy'].includes(pdf.density), `density=${pdf.density}`);
// 抽查 3 块无乱码：控制字符 / 私用区 / 替换符为 0
if (Array.isArray(pdf.preview)) {
  const bad = pdf.preview.filter((b) => /[\u0000-\u0008\uE000-\uF8FF\uFFFD]/.test(b.text)).length;
  ok('前 3 块无乱码字符', bad === 0, `bad=${bad}`);
  ok('每块都带页码', pdf.preview.every((b) => b.page !== null));
}

console.log('\n=== 2) DOCX（flow 模式）===');
const docx = await up('data/samples/test-cn.docx', '演示.docx', '');
ok('HTTP 200', docx.ok === true, `status=${docx.status}`);
ok('mode=flow', docx.mode === 'flow');
ok('pages 为 null', docx.pages === null, `pages=${JSON.stringify(docx.pages)}`);
if (Array.isArray(docx.preview)) {
  ok('page 全部为 NULL', docx.preview.every((b) => b.page === null));
  const secs = docx.preview.map((b) => b.section).filter(Boolean);
  ok('section 有回填', secs.length > 0, `first=${secs[0] ?? '-'}`);
}
ok('density=thin（短材料）', docx.density === 'thin', `density=${docx.density}`);

console.log('\n=== 3) 图片型 PDF（无文本层）===');
const scan = await up('data/samples/scanned.pdf', '扫描件.pdf', 'application/pdf');
ok('不是 500', scan.status !== 500, `status=${scan.status}`);
ok('返回可读错误码', scan.code === 'E_EMPTY_PDF', `code=${scan.code}`);
ok('错误信息是人话', typeof scan.message === 'string' && /扫描件|没有文字|没有可提取/.test(scan.message));

console.log('\n=== 4) S1 拦截无关类型 ===');
const pptx = await up('data/samples/test-cn.docx', '讲稿.pptx', '');
ok('PPTX 被拒', pptx.ok === false && pptx.code === 'E_EXT', `code=${pptx.code}`);
ok('提示里说明了不支持', /PPTX/.test(pptx.message ?? ''));

console.log(`\n===== ${pass} pass / ${fail} fail =====`);
process.exit(fail === 0 ? 0 : 1);
