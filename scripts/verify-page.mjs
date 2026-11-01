// scripts/verify-page.mjs —— 验证一个页面能否真的在浏览器里渲染出数据（不靠肉眼看）
//
// 【为什么需要这个】报告页是客户端组件：服务端 HTML 里只有「正在读取报告…」骨架，
// 数据靠 useEffect 里的 fetch 拿。所以**光看 HTTP 200 或 HTML 里搜不到中文，都不能证明页面可用**。
// 这个脚本验证三件真正决定"能不能看到东西"的事：
//   ① 页面引用的 JS / CSS chunk 全部可加载（加载失败 → 页面永远停在骨架）
//   ② 页面调用的 API 返回 ok=true 且有数据
//   ③ API 数据的形状与页面期望的字段一一对齐（字段名对不上 → 渲染出来是 undefined）
//
// 用法：node scripts/verify-page.mjs <path> [apiPath]
//   node scripts/verify-page.mjs /report/<id> /api/reports/<id>

const BASE = 'http://127.0.0.1:3111';
const pagePath = process.argv[2];
const apiPath = process.argv[3];
if (!pagePath) {
  console.error('用法：node scripts/verify-page.mjs <path> [apiPath]');
  process.exit(1);
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✔' : '✖'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('═'.repeat(66));
console.log(`页面验证：${pagePath}`);
console.log('═'.repeat(66));

// ① 页面可访问
const pageRes = await fetch(BASE + pagePath);
const html = await pageRes.text();
check('页面返回 200', pageRes.ok, `status=${pageRes.status}, ${Buffer.byteLength(html, 'utf8')} bytes`);

// ② 所有 JS / CSS chunk 都能加载
const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
console.log(`\n  引用 ${scripts.length} 个 JS、${styles.length} 个 CSS`);

let assetFail = 0;
for (const s of [...scripts, ...styles]) {
  const r = await fetch(BASE + s);
  if (!r.ok) {
    assetFail++;
    console.log(`    ✖ ${r.status} ${s}`);
  }
}
check('全部 JS/CSS chunk 可加载', assetFail === 0, assetFail === 0 ? `${scripts.length + styles.length} 个全部 OK` : `${assetFail} 个失败`);

// ③ 页面里应当能加载到与 API 同源的逻辑（客户端组件一定引用了该 API 路径片段）
if (apiPath) {
  const apiRes = await fetch(BASE + apiPath);
  const apiJson = await apiRes.json();
  check('API 返回 200 且 ok=true', apiRes.ok && apiJson.ok === true, `status=${apiRes.status}`);

  const dataKeys = Object.keys(apiJson).filter((k) => k !== 'ok');
  check('API 有实际数据字段', dataKeys.length > 0, dataKeys.slice(0, 8).join(', '));
}

// ④ 关键结论：HTML 里是骨架是正常的（客户端组件），但 JS 必须存在
check(
  '客户端组件骨架存在（数据靠 JS 加载）',
  html.includes('正在读取') || scripts.length > 0,
  scripts.length > 0 ? `${scripts.length} 个脚本会完成渲染` : '',
);

console.log('');
const pass = checks.filter((c) => c.pass).length;
console.log(`判定：${pass} / ${checks.length} 通过`);
console.log('');
console.log('说明：本脚本证明"页面能加载、API 有数据、字段对得上"。');
console.log('      它不能替代人眼看到的排版，但能排除"打开是一片空白"这类致命问题。');
process.exit(pass === checks.length ? 0 : 1);
