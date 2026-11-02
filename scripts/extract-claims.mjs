/** 触发质疑点抽取（POST /api/docs/:id/claims），打印耗时、条数、维度分布。 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const docId = process.argv[2];
if (!docId) {
  console.error('用法：node scripts/extract-claims.mjs <docId>');
  process.exit(1);
}
const t0 = Date.now();
const res = await fetch(`${BASE}/api/docs/${docId}/claims`, { method: 'POST' });
const j = await res.json();
console.log(`[extract] ${Date.now() - t0}ms ok=${j.ok} claims=${(j.claims ?? []).length}`);
if (!j.ok) {
  console.error(JSON.stringify(j).slice(0, 400));
  process.exit(1);
}
const g = await (await fetch(`${BASE}/api/docs/${docId}/claims`)).json();
const claims = g.claims ?? [];
const dims = {};
for (const c of claims) dims[c.dimension] = (dims[c.dimension] ?? 0) + 1;
const quoteTotal = claims.filter((c) => c.locator_kind !== 'absence').length;
const quoteHit = claims.filter((c) => c.locator_kind !== 'absence' && c.verified === 1).length;
console.log(`[claims] ${claims.length} 条`, JSON.stringify(dims));
console.log(`[quote] 命中 ${quoteHit}/${quoteTotal}`);
console.log(docId);
