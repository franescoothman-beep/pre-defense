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

const { planSeats, seatClaimIds } = await import('../lib/prompts/personas.v1.ts');
import fs from 'node:fs';

const seed = JSON.parse(fs.readFileSync('scripts/seed-demo-data.json', 'utf8'));
const rows = seed.claims;
const byDim = {};
for (const r of rows) byDim[r.dimension] = (byDim[r.dimension] ?? 0) + 1;
console.log('SEED FILE dim totals:', byDim);

const claims = rows.map((r) => ({
  id: String(r.id), type: r.type, dimension: r.dimension, risk: Number(r.risk),
  text: '', blockIdx: 0, page: null, section: null, quote: '', locatorKind: 'quote', verified: null,
}));
const seats = planSeats(claims, 3);
console.log('SEED FILE planSeats order:');
seats.forEach((s, i) =>
  console.log(`  seat ${i + 1}: dim=${s.dim} type=${s.type} cands=${s.candidates.length} ids=${s.candidates.map((c) => c.id.slice(0, 8)).join(',')}`));

const fx = JSON.parse(fs.readFileSync('fixtures/llm/personas.json', 'utf8')).seq[0].response.personas;
console.log('fixture order:', fx.map((p, i) => `judge${i + 1}=${p.name}(${p.role})`).join(' / '));

const validated = fx.slice(0, seats.length).map((p, i) => {
  const allowed = seatClaimIds(seats[i]);
  const openings = p.opening.filter((o) => allowed.has(o.claim_id));
  return { name: p.name, role: p.role, matched: openings.length };
});
const kept = validated.filter((v) => v.matched > 0).length;
console.log('RESULT validated.length =', kept, '(expected 3)');
validated.forEach((v, i) => console.log(`  judge ${i + 1} ${v.name}(${v.role}) matched ${v.matched}`));
