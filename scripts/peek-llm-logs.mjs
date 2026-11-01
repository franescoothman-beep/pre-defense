// scripts/peek-llm-logs.mjs —— 快速看最近几次模型调用（排障用，非交付脚本）
// 用法：node scripts/peek-llm-logs.mjs [limit]
import { DatabaseSync } from 'node:sqlite';

const limit = Number(process.argv[2] ?? 20);
const db = new DatabaseSync('data/app.db', { readOnly: true });
const rows = db.prepare(
  `select phase, model, ok, tokens, latency_ms, prompt_hash, created_at
   from llm_logs order by created_at desc limit ?`,
).all(limit);
db.close();

console.log(`最近 ${rows.length} 次模型调用：`);
for (const r of rows) {
  console.log(
    `  ${r.created_at}  ${String(r.phase).padEnd(9)} ${String(r.model).padEnd(14)} ok=${r.ok} ` +
      `tokens=${r.tokens} ${r.latency_ms}ms  hash=${r.prompt_hash}`,
  );
}
