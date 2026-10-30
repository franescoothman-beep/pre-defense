import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMaterialRisk, computeDelta, coverageOf, actionabilityOf, normalizePerformance, DIMENSIONS } from '../lib/report.ts';

const claims = [
  { id: 'c1', dimension: 'evidence', risk: 5, verified: 1, locator_kind: 'quote' },
  { id: 'c2', dimension: 'evidence', risk: 3, verified: 0, locator_kind: 'quote' },
  { id: 'c3', dimension: 'depth', risk: 4, verified: null, locator_kind: 'absence' },
];

test('aggregateMaterialRisk：由 claims 聚合，未覆盖维度返回 null', () => {
  const cells = aggregateMaterialRisk(claims);
  assert.equal(cells.length, 4);
  const ev = cells.find((c) => c.dimension === 'evidence')!;
  // c1: w=1, r=(5-1)/4=1 → 1*1 ; c2: w=0.5, r=(3-1)/4=0.5 → 0.25 ; den=1.5 → 1.25/1.5=0.8333 → 83
  assert.equal(ev.risk_score, 83);
  assert.equal(ev.claims, 2);

  const logic = cells.find((c) => c.dimension === 'logic')!;
  assert.equal(logic.risk_score, null, '该维无 claim 时必须为 null，不得补 0 或均值');
  assert.equal(logic.claims, 0);
});

test('aggregateMaterialRisk：同一批 claims 永远算出同一个分（可复算）', () => {
  const a = aggregateMaterialRisk(claims);
  const b = aggregateMaterialRisk([...claims].reverse());
  assert.deepEqual(a.map((x) => x.risk_score), b.map((x) => x.risk_score));
});

test('computeDelta：drill 只比 performance，risk 恒空（不产出 −0）', () => {
  const risk = aggregateMaterialRisk(claims);
  const prevPerf = normalizePerformance([{ dimension: 'evidence', score: 54 }]);
  const nowPerf = normalizePerformance([{ dimension: 'evidence', score: 72 }]);
  const d = computeDelta('drill', risk, risk, prevPerf, nowPerf);
  assert.equal(d.risk.length, 0, 'drill 绝不产出 risk 分差（否则永远是 −0）');
  assert.equal(d.perf.length, 1);
  assert.equal(d.perf[0].dimension, 'evidence');
  assert.equal(d.perf[0].prev, 54);
  assert.equal(d.perf[0].now, 72);
  assert.equal(d.perf[0].dir, 1, '上升=改善');
});

test('computeDelta：revise 只比 risk，perf 恒空', () => {
  const prev = aggregateMaterialRisk([{ id: 'a', dimension: 'evidence', risk: 5, verified: 1, locator_kind: 'quote' }]); // 100
  const now = aggregateMaterialRisk([{ id: 'b', dimension: 'evidence', risk: 3, verified: 1, locator_kind: 'quote' }]); // 50
  const d = computeDelta('revise', prev, now, null, null);
  assert.equal(d.perf.length, 0);
  assert.equal(d.risk.length, 1);
  assert.equal(d.risk[0].prev, 100);
  assert.equal(d.risk[0].now, 50);
  assert.equal(d.risk[0].dir, -1, 'risk 下降=改善');
  assert.equal(d.risk[0].source, 'doc_diff');
});

test('computeDelta：任一侧缺失的维度不产出条目', () => {
  const prev = aggregateMaterialRisk(claims);
  const now = aggregateMaterialRisk([{ id: 'x', dimension: 'depth', risk: 2, verified: 1, locator_kind: 'quote' }]);
  const d = computeDelta('revise', prev, now, null, null);
  // evidence 在 now 里为 null → 不产出；depth 在 prev 里是 60 左右 → 产出
  assert.ok(d.risk.every((x) => x.prev !== null && x.now !== null));
});

test('normalizePerformance：缺维补 null 而不是平均值', () => {
  const p = normalizePerformance([{ dimension: 'logic', score: 80 }]);
  assert.equal(p.length, 4);
  assert.equal(p.find((x) => x.dimension === 'logic')!.score, 80);
  assert.equal(p.find((x) => x.dimension === 'evidence')!.score, null);
});

test('coverageOf：给出覆盖度文案', () => {
  const risk = aggregateMaterialRisk(claims);
  const perf = normalizePerformance([{ dimension: 'logic', score: 70 }, { dimension: 'evidence', score: 60 }]);
  const c = coverageOf(risk, perf);
  assert.equal(c.risk.covered, 2);
  assert.equal(c.perf.covered, 2);
  assert.ok(c.note.includes('2/4'));
});

test('actionabilityOf：「该写没写」占比', () => {
  const a = actionabilityOf(claims);
  assert.equal(a.total, 3);
  assert.equal(a.absence, 1);
  assert.ok(Math.abs(a.ratio - 1 / 3) < 1e-9);
});

test('维度定义完整（报表与看板依赖顺序）', () => {
  assert.deepEqual(DIMENSIONS, ['logic', 'evidence', 'depth', 'expression']);
});
