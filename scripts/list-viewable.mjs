// scripts/list-viewable.mjs —— 列出当前库里"能直接打开看效果"的材料、会话、报告
// 用法：node scripts/list-viewable.mjs
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/app.db', { readOnly: true });

const reports = db.prepare(
  `select r.session_id as id, s.mode as mode, d.name as docName, r.created_at as at,
     (select count(*) from turns t where t.session_id = r.session_id and t.question != '') as turns,
     (select count(*) from turns t where t.session_id = r.session_id and t.answer is not null and t.answer != '') as answered
   from reports r
   join sessions s on s.id = r.session_id
   left join documents d on d.id = s.doc_id
   order by r.created_at desc limit 8`,
).all();

const docs = db.prepare(
  `select d.id, d.name, d.mode, d.pages, d.chars,
     (select count(*) from claims c where c.doc_id = d.id) as claims,
     (select count(*) from blocks b where b.doc_id = d.id) as blocks
   from documents d order by d.created_at desc limit 8`,
).all();

const sessionsNoReport = db.prepare(
  `select s.id, s.mode, s.state, d.name as docName, s.started_at
   from sessions s left join documents d on d.id = s.doc_id
   where s.id not in (select session_id from reports)
   order by s.started_at desc limit 8`,
).all();

console.log('══════════ 报告（打开 /report/<id>）══════════');
if (reports.length === 0) console.log('  （还没有报告，先跑一场到「结束并出报告」）');
for (const r of reports) {
  console.log(`  /report/${r.id}`);
  console.log(`     ${r.docName} · ${r.mode} · 问 ${r.turns} 条 / 答 ${r.answered} 条 · ${r.at}`);
}

console.log('\n══════════ 材料（打开 /doc/<id> 看质疑点卡片）══════════');
for (const d of docs) {
  console.log(`  /doc/${d.id}`);
  console.log(`     ${d.name} · ${d.mode} · ${d.pages ?? '-'} 页 / ${d.chars} 字 · ${d.blocks} 块 · ${d.claims} 条质疑点`);
}

console.log('\n══════════ 未出报告的会话（打开 /session/<id> 继续答）══════════');
if (sessionsNoReport.length === 0) console.log('  （无）');
for (const s of sessionsNoReport) {
  console.log(`  /session/${s.id}`);
  console.log(`     ${s.docName} · ${s.mode} · state=${s.state} · ${s.started_at}`);
}

db.close();
