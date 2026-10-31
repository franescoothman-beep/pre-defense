import test from 'node:test';
import assert from 'node:assert/strict';
import { planSeats, seatClaimIds, buildPersonasUser, type ClaimForPersona } from '../lib/prompts/personas.v1.ts';

function claim(
  id: string,
  type: ClaimForPersona['type'],
  dimension: ClaimForPersona['dimension'],
  risk = 3,
): ClaimForPersona {
  return {
    id,
    type,
    text: `质疑点 ${id}`,
    dimension,
    risk,
    blockIdx: 1,
    page: null,
    section: null,
    quote: '一二三四五六七八',
    locatorKind: 'quote',
    verified: 1,
  };
}

test('planSeats：样例材料的真实分布（method 10 / engineering 0 / value 2）不再强造 engineering 席位', () => {
  // 【回归测试，对应 2026-10-31 真实 key 首跑暴露的串味缺陷】
  // 旧实现按「method / engineering / value 三位类型齐全」硬分，
  // 而材料里 engineering 实际 0 条 → 那位评委只能借别人的 claim 去问，
  // 首问从「工程实现」滑成「因果推断链条」。
  // 新实现按真实存在的维度分席位：宁可两位同为 method，也不假装有位 engineering 评委。
  const claims = [
    ...Array.from({ length: 5 }, (_, i) => claim(`m-ev-${i}`, 'method', 'evidence', 5)),
    ...Array.from({ length: 4 }, (_, i) => claim(`m-lo-${i}`, 'method', 'logic', 4)),
    ...Array.from({ length: 1 }, (_, i) => claim(`m-de-${i}`, 'method', 'depth', 3)),
    ...Array.from({ length: 2 }, (_, i) => claim(`v-de-${i}`, 'value', 'depth', 3)),
  ];
  const seats = planSeats(claims, 3);
  assert.equal(seats.length, 3, '仍然排出 3 个席位（quick 档 3 位评委）');

  // 关键断言 1：维度必须两两不同 —— 这才是"不串味"的实质
  const dims = seats.map((s) => s.dim);
  assert.equal(new Set(dims).size, 3, `三维必须两两不同，实际 ${dims.join(',')}`);

  // 关键断言 2：不再凭空出现一个 engineering 类型席位
  const types = seats.map((s) => s.type);
  assert.ok(!types.includes('engineering'), `材料没有 engineering 就不能造，实际 ${types.join(',')}`);
});

test('planSeats：席位只装自己维度的候选（跨维度借用从根上不可能）', () => {
  const claims = [
    claim('a', 'method', 'evidence'),
    claim('b', 'method', 'logic'),
    claim('c', 'method', 'depth'),
    claim('d', 'value', 'expression'),
  ];
  const seats = planSeats(claims, 3);
  for (const s of seats) {
    for (const c of s.candidates) {
      assert.equal(c.dimension, s.dim, `席位 ${s.dim} 里混进了 ${c.dimension} 的 claim`);
    }
  }
});

test('planSeats：条数多的维度优先上席（材料真正有料的地方先问）', () => {
  const claims = [
    ...Array.from({ length: 6 }, (_, i) => claim(`e${i}`, 'method', 'evidence')),
    claim('l0', 'method', 'logic'),
    claim('d0', 'method', 'depth'),
  ];
  const seats = planSeats(claims, 3);
  assert.equal(seats[0].dim, 'evidence', '条数最多的维度应排第一席');
});

test('planSeats：真实维度不足时用剩余组合补位，但不超过 want', () => {
  const claims = [claim('a', 'method', 'logic'), claim('b', 'value', 'logic', 4)];
  const seats = planSeats(claims, 3);
  assert.ok(seats.length <= 3);
  assert.ok(seats.length >= 1, '至少要给出一席，不能 0 席让会话建不起来');
});

test('planSeats：空 claims → 0 席（由路由转成可读错误，不是静默建一个空会话）', () => {
  assert.equal(planSeats([], 3).length, 0);
});

test('seatClaimIds：只含本席位候选，用来做锚点归属校验', () => {
  const seats = planSeats(
    [claim('a', 'method', 'evidence'), claim('b', 'method', 'logic')],
    2,
  );
  assert.equal(seats.length, 2);
  const ids0 = seatClaimIds(seats[0]);
  const ids1 = seatClaimIds(seats[1]);
  assert.ok(ids0.has('a'));
  assert.ok(!ids0.has('b'), '第 1 席不许拿到第 2 席的 claim —— 这正是串味的入口');
  assert.ok(ids1.has('b'));
});

test('buildPersonasUser：不再出现"本类没有质疑点，可引用其它类型"这句放行话', () => {
  // 旧 prompt 在候选为空时直接写「请仍然生成这位评委，opening 只能引用其它类型的候选」，
  // 等于亲手把串味写成了合法行为。
  const claims = [
    claim('m1', 'method', 'evidence'),
    claim('m2', 'method', 'logic'),
    claim('v1', 'value', 'depth'),
  ];
  const user = buildPersonasUser(claims, 3);
  assert.ok(!user.includes('其它类型'), '不得再放行跨类型借用');
  assert.ok(user.includes('席位分配表'), '应明确给出席位分配表');
  assert.ok(user.includes('不许跨席位借用'));
});
