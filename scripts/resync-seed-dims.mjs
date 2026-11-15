import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try { return nextResolve(specifier + ext, context); } catch {}
      }
    }
    return nextResolve(specifier, context);
  },
});

const { q, tx } = await import('../lib/db.ts');
import fs from 'node:fs';

const DOC_ID = '07b4f607-5393-4617-82b4-a5ea67e605dc';
const seed = JSON.parse(fs.readFileSync('scripts/seed-demo-data.json', 'utf8'));

// 1) 确认库里所有 seed claim id 都在（保证不是 id 漂移，只是 dimension 过时）
const live = new Set(q.all('select id from claims where doc_id = ?', DOC_ID).map((r) => String(r.id)));
const missing = seed.claims.filter((c) => !live.has(c.id));
if (missing.length > 0) {
  console.error(`[resync] 库里缺 ${missing.length} 条 seed claim id，这不是纯 dimension 漂移，停止。先跑 demo.mjs 重新灌库。`);
  process.exit(1);
}

// 2) 仅更新 dimension（type 也一并以 seed 为准，避免后续 planSeats 再错位）
const before = q.all('select id, dimension, type from claims where doc_id = ?', DOC_ID)
  .map((r) => ({ id: String(r.id), dimension: String(r.dimension), type: String(r.type) }));
const byBefore = new Map(before.map((b) => [b.id, b]));

tx(() => {
  for (const c of seed.claims) {
    const b = byBefore.get(c.id);
    if (b && (b.dimension !== c.dimension || b.type !== c.type)) {
      q.run('update claims set dimension = ?, type = ? where id = ?', c.dimension, c.type, c.id);
    }
  }
});

const after = q.all('select dimension, count(*) as n from claims where doc_id = ? group by dimension', DOC_ID);
console.log('[resync] 库内 dimension 分布已对齐 seed：', Object.fromEntries(after.map((r) => [r.dimension, Number(r.n)])));
console.log('[resync] 完成。重启 demo 服务后跑 verify-demo-loop.mjs 复验。');
