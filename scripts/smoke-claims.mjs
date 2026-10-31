// scripts/smoke-claims.mjs —— 阶段 2 端到端验收（MOCK_LLM=1，零 key 零网络）
//
// 用法：先 `MOCK_LLM=1 next start -p 3100`，再 `node scripts/smoke-claims.mjs`
//
// 验收三条 DoD：
//   1) 能从材料抽出质疑点（≥5 条）
//   2) **quote 机检命中率 = 100%**（fixture 的 quote 是逐字切出来的，必须全中）
//   3) page/section 由服务端回填（模型不输出这两个字段）
// 外加：absence 类单独统计，不混进 quote 分母
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

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

// 1) 上传内置样例 docx
const body = new FormData();
body.append(
  'file',
  new Blob([fs.readFileSync('fixtures/demo/sample-paper.docx')], { type: '' }),
  'sample-paper.docx',
);
const up = await (await fetch(`${BASE}/api/docs`, { method: 'POST', body })).json();
ok('上传内置样例', up.ok === true, `docId=${up.docId} mode=${up.mode} blocks=${up.blocks}`);
if (!up.ok) process.exit(1);

const docId = up.docId;

// 2) 抽取质疑点
console.log('\n=== 质疑点抽取（MOCK 回放）===');
const r = await fetch(`${BASE}/api/docs/${docId}/claims`, { method: 'POST' });
const j = await r.json();
ok('HTTP 200', r.status === 200, `status=${r.status}`);
ok('抽到质疑点', j.ok === true && j.total >= 5, `total=${j.total} batches=${j.batches}`);

// 3) quote 机检命中率必须是 100%（fixture 逐字切片保证）
console.log('\n=== 机检（逐字命中）===');
ok(
  'quote 命中率 = 100%',
  j.quote && j.quote.total > 0 && j.quote.hit === j.quote.total,
  `${j.quote?.hit}/${j.quote?.total} = ${(j.quote?.rate * 100).toFixed(1)}%`,
);
ok('absence 类单独统计（不进 quote 分母）', j.absence && j.absence.total > 0, `absence=${j.absence?.total} 条`);

// 4) page/section 由服务端回填
console.log('\n=== 服务端回填 ===');
const withLoc = j.claims.filter((c) => c.section !== null);
ok('section 已回填', withLoc.length > 0, `首条 section=${j.claims[0]?.section ?? '-'}`);

// 5) 逐条核对：quote 类必须 verified=1，absence 类必须 verified=null
console.log('\n=== 逐条一致性 ===');
const bad = j.claims.filter(
  (c) => (c.locator_kind === 'quote' && c.verified !== 1) || (c.locator_kind === 'absence' && c.verified !== null),
);
ok('每条 locator 的 verified 与其 kind 匹配', bad.length === 0, `异常 ${bad.length} 条`);

// 6) 二次抽取必须是替换而非叠加（防止命中率分母虚高）
console.log('\n=== 重抽幂等 ===');
const r2 = await (await fetch(`${BASE}/api/docs/${docId}/claims`, { method: 'POST' })).json();
ok('重抽后条数不翻倍', r2.total === j.total, `第一次 ${j.total}，第二次 ${r2.total}`);

// 7) GET 读回
const g = await (await fetch(`${BASE}/api/docs/${docId}/claims`)).json();
ok('GET 能读回同批数据', g.ok === true && g.claims.length === j.total, `${g.claims?.length} 条`);

console.log(`\n===== ${pass} pass / ${fail} fail =====`);
process.exit(fail === 0 ? 0 : 1);
