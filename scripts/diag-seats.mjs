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

const { q } = await import('../lib/db.ts');
const { planSeats, seatClaimIds } = await import('../lib/prompts/personas.v1.ts');
import fs from 'node:fs';

const DOC_ID = '07b4f607-5393-4617-82b4-a5ea67e605dc';

const rows = q.all(
  `select id, type, dimension, risk from claims where doc_id = ? order by risk desc`,
  DOC_ID,
);
console.log('live claims:', rows.length);

const byDim = {};
for (const r of rows) byDim[r.dimension] = (byDim[r.dimension] ?? 0) + 1;
console.log('dim totals:', byDim);

const claims = rows.map((r) => ({
  id: String(r.id), type: r.type, dimension: r.dimension, risk: Number(r.risk),
  text: '', blockIdx: 0, page: null, section: null, quote: '', locatorKind: 'quote', verified: null,
}));

const logicMethod = claims.filter((c) => c.dimension === 'logic' && c.type === 'method').sort((a,b)=>b.risk-a.risk);
console.log('\n=== logic/method candidate claims (non-anchor, safe to recolor) ===');
logicMethod.forEach((c) => console.log(`id=${c.id} risk=${c.risk} quote="${c.quote.slice(0,40)}"`));

const seats = planSeats(claims, 3);
console.log('\n=== live planSeats order ===');
seats.forEach((s, i) =>
  console.log(`seat ${i + 1}: dim=${s.dim} type=${s.type} cands=${s.candidates.length} ` +
    `claimIds=${s.candidates.map((c) => c.id.slice(0, 8)).join(',')}`));

const fx = JSON.parse(fs.readFileSync('fixtures/llm/personas.json', 'utf8')).seq[0].response.personas;
console.log('\n=== personas.json fixture order ===');
fx.forEach((p, i) =>
  console.log(`judge ${i + 1}: name=${p.name} role=${p.role} ` +
    `opening0=${p.opening[0].claim_id.slice(0, 8)} opening1=${p.opening[1]?.claim_id.slice(0, 8)}`));

console.log('\n=== index alignment simulation (route logic) ===');
const validated = fx
  .slice(0, seats.length)
  .map((p, i) => {
    const allowed = seatClaimIds(seats[i]);
    const openings = p.opening.filter((o) => allowed.has(o.claim_id));
    return { name: p.name, role: p.role, matched: openings.length, allowed: [...allowed].map((x) => x.slice(0, 8)) };
  });
validated.forEach((v, i) =>
  console.log(`judge ${i + 1} ${v.name}(${v.role}) → matched ${v.matched} / seat ${i + 1} allowed [${v.allowed.join(',')}]`));
const kept = validated.filter((v) => v.matched > 0).length;
console.log(`\nRESULT: validated.length = ${kept} (expected 3)`);
