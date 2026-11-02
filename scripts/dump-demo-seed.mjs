// scripts/dump-demo-seed.mjs —— 把"已抽好质疑点的内置样例"从当前库导出成可复现的种子 JSON。
//
// 为什么需要这一步（而不是让 demo 现场上传 + 抽 claims）：
//   1) 演示模式前端**禁用上传**（mockMode → input disabled），所以现场上传这条路在 mock 下根本走不通；
//   2) 即便放开，fresh clone 的库是空的，/api/demo 会返回 E_NO_DEMO_DOC，用户被卡在第二个失败点；
//   3) 最关键：**personas 回放锚点的是具体 claim_id**。如果 demo 库的 claim 是新生成的 UUID，
//      录制好的 personas.json 里的 opening.claim_id 就指不到任何座位候选 → 评委被丢成 1 位。
//      所以必须**原样保留真实抽取时的 claim id / block_idx / quote / dimension / risk**，
//      这样运行时算出来的席位和录制时完全一致，mock 回放才接得上。
//
// 产物 scripts/seed-demo-data.json 入库；demo.mjs 在起服务前若发现库里没有这份样例就把它灌进去。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA = path.join(process.cwd(), 'data', 'app.db');
const DEMO_NAME = 'sample-paper.docx';

if (!fs.existsSync(DATA)) {
  console.error('当前库还没有数据（先真实跑一次 demo 文档的抽取）。');
  process.exit(1);
}

const db = new DatabaseSync(DATA);
// 同一份样例可能被反复上传成多个 docId，优先取"有 claims 且最多"的那条（与材料列表去重规则一致）
const doc = db
  .prepare(
    `select d.* from documents d
     where d.name = ?
     order by (select count(*) from claims c where c.doc_id = d.id) desc, created_at desc
     limit 1`,
  )
  .get(DEMO_NAME);
if (!doc) {
  console.error(`库里找不到名为 ${DEMO_NAME} 的样例文档。`);
  process.exit(1);
}
const claimsCount = db
  .prepare('select count(*) as n from claims where doc_id = ?')
  .get(String(doc.id)).n;
if (Number(claimsCount) === 0) {
  console.error(`样例文档 ${doc.id} 还没有 claims，先抽过再导出。`);
  process.exit(1);
}

const blocks = db.prepare('select * from blocks where doc_id = ? order by idx').all(String(doc.id));
const claims = db.prepare('select * from claims where doc_id = ? order by block_idx').all(String(doc.id));

// 内容指纹：与 fixtures/demo/sample-paper.docx 对齐，保证 demo 守卫（若将来放开上传）也认得这份样例
const sampleBytes = fs.readFileSync(path.join(process.cwd(), 'fixtures', 'demo', 'sample-paper.docx'));
const contentHash = crypto.createHash('sha256').update(sampleBytes).digest('hex');

const out = {
  doc: {
    id: String(doc.id),
    name: DEMO_NAME,
    path: String(doc.path),
    pages: doc.pages === null ? null : Number(doc.pages),
    chars: Number(doc.chars),
    mode: String(doc.mode),
    density: String(doc.density),
    status: String(doc.status),
    content_hash: contentHash,
  },
  blocks: blocks.map((b) => ({
    id: String(b.id),
    idx: Number(b.idx),
    page: b.page === null ? null : Number(b.page),
    section: b.section === null ? null : String(b.section),
    text: String(b.text),
    char_len: Number(b.char_len),
  })),
  claims: claims.map((c) => ({
    id: String(c.id),
    type: String(c.type),
    text: String(c.text),
    block_idx: Number(c.block_idx),
    page: c.page === null ? null : Number(c.page),
    section: c.section === null ? null : String(c.section),
    quote: String(c.quote),
    locator_kind: String(c.locator_kind),
    scope: c.scope === null ? null : String(c.scope),
    verified: c.verified === null ? null : Number(c.verified),
    risk: Number(c.risk),
    dimension: String(c.dimension),
  })),
};

const target = path.join(process.cwd(), 'scripts', 'seed-demo-data.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`导出 ${target}`);
console.log(`  文档 ${out.doc.id} · ${out.blocks.length} 块 · ${out.claims.length} 条 claims`);
console.log(`  维度分布：`, (() => {
  const m = {};
  for (const c of out.claims) m[c.dimension] = (m[c.dimension] ?? 0) + 1;
  return m;
})());
