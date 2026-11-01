// scripts/probe-report-shape.mjs —— 复现报告 schema 失败的形状问题
//
// 【这个脚本测什么】
// 真实跑一次 /end 时，报告调用报了：
//   E_SCHEMA: expected number, received undefined → at material_risk[0].locators[0].block_idx
// 说明模型给的 locator 里**没有 block_idx**。
// 这个脚本直接调 lib 层的 prompt 与 schema，把模型原始输出打出来，
// 从而区分两件事：
//   · 是 prompt 没告诉它要给什么（我们的锅）
//   · 还是模型不听话（prompt 必须写得更硬）
//
// 用法：node scripts/probe-report-shape.mjs

import { DatabaseSync } from 'node:sqlite';
import { REPORT_SYSTEM, buildReportUser, ReportSchema } from '../lib/prompts/report.v1.ts';
import { DIMENSIONS } from '../lib/report.ts';
import { readFileSync, existsSync } from 'node:fs';

const db = new DatabaseSync('data/app.db', { readOnly: true });
const session = db.prepare(`select id, doc_id, mode, state from sessions order by started_at desc limit 1`).get();
if (!session) {
  console.error('库里没有会话');
  process.exit(1);
}
const claims = db.prepare(
  `select id, type, text, dimension, risk, block_idx, page, section, quote, locator_kind, verified
   from claims where doc_id = ? order by risk desc`,
).all(session.doc_id);
const blocks = db.prepare(`select idx, text from blocks where doc_id = ?`).all(session.doc_id);
const turns = db.prepare(
  `select t.question, t.answer, t.score, t.gaps, t.kind, p.name
   from turns t left join personas p on p.id = t.persona_id
   where t.session_id = ? order by t.seq`,
).all(session.id);
const doc = db.prepare(`select name from documents where id = ?`).get(session.doc_id);
db.close();

const sources = new Map();
for (const b of blocks) sources.set(Number(b.idx), String(b.text));

const user = buildReportUser({
  docName: String(doc.name),
  mode: String(session.mode),
  modeLabel: '快速评审（3 位各 1 问）',
  coveredDimensions: DIMENSIONS.map((d) => d),
  riskByDimension: DIMENSIONS.map((d) => ({
    dimension: d,
    riskScore: 50,
    claims: claims.filter((c) => c.dimension === d).length,
  })),
  claims: claims.map((c) => ({
    id: String(c.id),
    text: String(c.text),
    dimension: String(c.dimension),
    risk: Number(c.risk),
    type: String(c.type),
    quote: String(c.quote ?? ''),
    locatorKind: String(c.locator_kind),
    section: c.section === null ? null : String(c.section),
    page: c.page === null ? null : Number(c.page),
    askedInSession: true,
  })),
  turns: turns.map((t) => ({
    personaName: String(t.name ?? '评委'),
    question: String(t.question),
    answer: t.answer === null ? null : String(t.answer),
    score: t.score === null ? null : Number(t.score),
    gaps: t.gaps === null ? null : String(t.gaps),
    kind: String(t.kind),
  })),
  sources: [...sources.entries()].slice(0, 8).map(([blockIdx, text]) => ({ blockIdx, text })),
  qTotal: 3,
});

const key = readEnvLocal('DEEPSEEK_API_KEY');
const base = (readEnvLocal('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/$/, '');
if (!key) {
  console.error('没有 key');
  process.exit(1);
}

function readEnvLocal(name) {
  const p = '.env.local';
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^${name}=(.+)$`).exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
}

const url = `${base}/chat/completions`;
const body = {
  model: 'deepseek-chat',
  temperature: 0.3,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: REPORT_SYSTEM },
    { role: 'user', content: user },
  ],
};

console.log('═'.repeat(70));
console.log('直接调用报告 prompt，看模型到底给了什么形状');
console.log('═'.repeat(70));
console.log(`user prompt 长度：${user.length} 字`);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const j = await res.json();
const text = j.choices?.[0]?.message?.content ?? '';
console.log(`\n模型原始输出（${text.length} 字）：\n`);
console.log(text);

let parsed = null;
try { parsed = JSON.parse(text); } catch { console.log('\n(不是裸 JSON)'); }
if (parsed) {
  const checked = ReportSchema.safeParse(parsed);
  console.log('\nzod 校验：', checked.success ? '通过' : '失败');
  if (!checked.success) {
    console.log(JSON.stringify(checked.error.issues.slice(0, 8), null, 2));
  }
  const firstLoc = parsed.material_risk?.[0]?.locators?.[0];
  console.log('\nmaterial_risk[0].locators[0] 实际形状：', JSON.stringify(firstLoc));
}
