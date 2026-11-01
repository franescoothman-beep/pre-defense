import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  MODE_MATRIX,
  mainsDoneOf,
  mainsNeededOf,
  judgesOf,
  personaIndexOfMain,
  isFinished,
  progressOf,
  HARD_LIMITS,
  FALLBACK_FOLLOWUP,
  type SessionSnapshot,
} from '../lib/state.ts';

/**
 * 阶段 4 的状态机测试（在阶段 0 的 11 条基础上补）。
 *
 * 【本文件专门覆盖的三件新事】
 *   ① round 口径修正 —— 旧实现把 quick 档 3 个主问全塞进 round 1
 *   ② 主问配额用尽即收口 —— C11「报告永不缺席」的落点
 *   ③ 实际评委数 < 理论数时不能空转 —— 材料维度不足只有 2 位评委的场子
 * 第 ③ 条尤其重要：旧实现等第 3 位评委永远等不到，会一直空转到轮次上限。
 */

function snap(mode: SessionSnapshot['mode'], over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    mode, state: 'ASKING', turns: [], askedClaimIds: [], callCount: 1,
    lastQuestionAt: Date.now(), startedAt: Date.now(), ...over,
  };
}

function q(seq: number, round: number, personaId: string, claimId = `c${seq}`) {
  return { seq, round, kind: 'question' as const, personaId, targetClaimId: claimId, question: `主问 ${seq}` };
}
function f(seq: number, round: number, personaId: string, question = '再深一层的追问') {
  return { seq, round, kind: 'followup' as const, personaId, targetClaimId: 'c1', question };
}

// ─────────────────────────── round 口径 ───────────────────────────

test('round 口径：quick 档 3 个主问的 round 是 1/2/3（不是 1/1/1）', () => {
  // 旧实现用 ceil(seq/judges)：seq=1,2,3 全落在 round 1。
  // 后果是"本轮追问几次"永远算不对——第 3 问的追问被当成第 1 问的追问。
  const s = snap('quick', { turns: [q(1, 1, 'p1'), q(2, 2, 'p2'), q(3, 3, 'p3')] });
  assert.equal(s.turns[2].round, 3);
  assert.equal(mainsDoneOf(s.turns), 3);
});

test('round 口径：追问继承所属主问的 round（round 2 的追问算在 round 2 里，不算 round 1）', () => {
  // 场景：第 1 问、第 2 问都问完了，第 2 问追过一次。
  // 旧口径下这 3 条 turn 的 round 全是 1，于是"本轮已追问几次"被算成 1 次 yet
  // 归属给了第 1 轮 —— 第 2 轮的配额被提前吃掉。
  // 新口径：最后一条 turn 的 round=2，round 2 的追问数=1。
  const s = snap('full', {
    turns: [q(1, 1, 'p1'), q(2, 2, 'p2'), f(3, 2, 'p2')],
  });
  // full 档每位可追问 2 次；round 2 只追过 1 次 → 仍允许再追一次
  const r = decide(s, { followup: { question: '那这一层抽样具体怎么做的', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'followup', 'round 2 只追过 1 次，full 档配额 2 次，应允许');
});

test('round 口径：quick 档 round 2 追过多一次就到了本轮上限 → 不再追问', () => {
  // quick 档 followupsEach=1，所以同一轮追过 1 次即满。
  const s = snap('quick', {
    turns: [q(1, 1, 'p1'), q(2, 2, 'p2'), f(3, 2, 'p2')],
  });
  const r = decide(s, { followup: { question: '还想再深一层追问一句', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /追问已达 1 次上限/);
});

// ─────────────────────────── quick 档「3 问后必然进报告」 ───────────────────────────

test('DoD：quick 档 3 位各 1 问后 → decide 返回 end（报告永不缺席）', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1'), q(2, 2, 'p2'), q(3, 3, 'p3')] });
  const r = decide(s, { followup: { question: '还能再追问一句', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'end');
  assert.match(r.reason, /主问已问完/);
});

test('DoD：quick 档 3 问后 isFinished 为 true', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1'), q(2, 2, 'p2'), q(3, 3, 'p3')] });
  assert.equal(isFinished(s, 3), true);
});

test('quick 档：第 2 问后仍然继续（不该提前收口）', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1'), q(2, 2, 'p2')] });
  const r = decide(s, { followup: null }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.doesNotMatch(r.reason, /主问已问完/);
});

test('quick 档：3 问 + 3 追问 = 6 轮，仍在上限内，但主问配额已尽即收口', () => {
  const s = snap('quick', {
    turns: [q(1, 1, 'p1'), f(2, 1, 'p1'), q(3, 2, 'p2'), f(4, 2, 'p2'), q(5, 3, 'p3'), f(6, 3, 'p3')],
  });
  assert.equal(s.turns.length, 6, '正好 6 轮 = quick 的 maxTurns');
  const r = decide(s, null, Date.now());
  assert.equal(r.decision, 'end');
});

// ─────────────────────────── mode 矩阵 ───────────────────────────

test('mode 矩阵：quick 必须允许追问（followupsEach≥1），否则默认档一次追问都没有', () => {
  // 【为什么这条要单测】旧值 followupsEach: 0 意味着 quick 档（= 默认档 = 演示走的档）
  // 永远不会有追问。而"轮番提问与追问"是这个产品名字的一半——
  // 默认档里一次追问都没有，产品看起来就是半成品。
  assert.ok(MODE_MATRIX.quick.followupsEach >= 1, 'quick 档必须能追问');
  assert.ok(MODE_MATRIX.quick.maxTurns <= 6, 'quick 档上限 6 轮（3–6 轮出报告）');
  assert.equal(MODE_MATRIX.full.maxTurns, 15, 'full 档 ≤15 轮');
  assert.equal(MODE_MATRIX.full.followupsEach, 2, 'full 档每位最多 2 次追问');
  assert.equal(MODE_MATRIX.drill.maxTurns, 5);
});

test('mode 矩阵：quick 档 3 位 × 1 主问 = 3 个主问', () => {
  assert.equal(mainsNeededOf({ mode: 'quick', judges: 3 }), 3);
  assert.equal(mainsNeededOf({ mode: 'full', judges: 3 }), 9);
  assert.equal(mainsNeededOf({ mode: 'single', judges: 1 }), 3);
});

// ─────────────────────────── 评委轮转（追问不推进评委） ───────────────────────────

test('personaIndexOfMain：quick 档一问换一位（0/1/2）', () => {
  assert.equal(personaIndexOfMain(0, 1, 3), 0);
  assert.equal(personaIndexOfMain(1, 1, 3), 1);
  assert.equal(personaIndexOfMain(2, 1, 3), 2);
});

test('personaIndexOfMain：full 档三问换一位（0/0/0/1/1/1/2/2/2）', () => {
  const seats = Array.from({ length: 9 }, (_, i) => personaIndexOfMain(i, 3, 3));
  assert.deepEqual(seats, [0, 0, 0, 1, 1, 1, 2, 2, 2]);
});

test('personaIndexOfMain：越界时钳到最后一席（不返回 undefined 的座位）', () => {
  assert.equal(personaIndexOfMain(99, 1, 3), 2);
});

test('personaIndexOfMain：真实缺陷回归——追问不推进评委', () => {
  // 旧实现用 answered % personas.length，answered 把追问也算进去：
  // 第 1 位问完 + 追问一次 → answered=2 → 下一位主问会跳到第 3 位评委。
  // 这就是"第 2 位评委一次没问、第 1 位被问了两轮"的错位。
  // 新口径只看主问序号的 floor(mains / mainsEach)。
  const mainsAfterSeat0 = 1; // 第 1 位问完 1 个主问
  assert.equal(personaIndexOfMain(mainsAfterSeat0, 1, 3), 1, '第 2 个主问必须是第 2 位评委');
});

// ─────────────────────────── 实际评委数 < 理论数 ───────────────────────────

test('judgesOf：实际 2 位评委时按 2 位算（不空等第 3 位）', () => {
  // 材料只有 logic/evidence 两维（engineering 类 claim 为 0）时，planSeats 只排 2 席。
  // 若仍按 mode 的理论 3 位等第 3 问，这场会一直空转到轮次上限。
  assert.equal(judgesOf({ mode: 'quick', judges: 2 }), 2);
  assert.equal(mainsNeededOf({ mode: 'quick', judges: 2 }), 2);
});

test('judgesOf：2 位评委问完 2 个主问 → 立刻收口', () => {
  const s = snap('quick', { judges: 2, turns: [q(1, 1, 'p1'), q(2, 2, 'p2')] });
  const r = decide(s, null, Date.now());
  assert.equal(r.decision, 'end');
});

test('judgesOf：实际数超过 mode 上限时按上限截断', () => {
  assert.equal(judgesOf({ mode: 'single', judges: 3 }), 1, 'single 档就是 1 位，多出来的不参与轮转');
});

test('judgesOf：没有 judges 信息时退回 mode 的理论值', () => {
  assert.equal(judgesOf({ mode: 'quick' }), 3);
});

// ─────────────────────────── 20 轮压力用例（不死循环） ───────────────────────────

test('压力：构造 20 轮 full 档，在 15 轮必结束（不死循环）', () => {
  // DoD 原文：「构造 20 轮压力用例，验证 ≤15 轮必结束、不死循环」
  const turns = Array.from({ length: 15 }, (_, i) =>
    i % 2 === 0 ? q(i + 1, Math.floor(i / 3) + 1, `p${(i % 3) + 1}`) : f(i + 1, Math.floor(i / 3) + 1, `p${(i % 3) + 1}`),
  );
  const s = snap('full', { turns });
  const r = decide(s, { followup: { question: '还没问够，再追问一句', target_claim_id: 'c99', resolved: false } }, Date.now());
  assert.equal(r.decision, 'end', '15 轮必须结束');
  assert.match(r.reason, /轮次上限 15/);
  assert.equal(MODE_MATRIX.full.maxTurns, 15);
});

test('压力：20 条 turn（超过 15 上限）→ 仍然 end，不抛错、不返回 ask', () => {
  const turns = Array.from({ length: 20 }, (_, i) => q(i + 1, i, `p${(i % 3) + 1}`));
  const s = snap('full', { turns });
  const r = decide(s, null, Date.now());
  assert.equal(r.decision, 'end');
});

test('压力：模型一直给 resolved=false 的新追问，仍会在轮次上限处收口', () => {
  // 模拟"模型永不收敛"的对抗场景：每轮都想追问，每次都换一个新 claim。
  // 这类输入必须靠代码收口，不能交给模型自觉。
  for (let n = 1; n <= 16; n++) {
    const turns = Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? q(i + 1, Math.floor(i / 3) + 1, `p${(i % 3) + 1}`)
        : f(i + 1, Math.floor(i / 3) + 1, `p${(i % 3) + 1}`, `追问 ${i}`),
    );
    const r = decide(snap('full', { turns }), { followup: { question: `新的追问第 ${n} 次`, target_claim_id: `c${n}`, resolved: false } }, Date.now());
    if (n >= 15) assert.equal(r.decision, 'end', `${n} 轮时必须结束`);
  }
});

// ─────────────────────────── 被试 7 条规则其余项 ───────────────────────────

test('规则 3：quick 档本轮追问 1 次已满 → 不再追问', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1'), f(2, 1, 'p1')] });
  const r = decide(s, { followup: { question: '第三次追问一句', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /追问已达/);
});

test('规则 5：20 分钟无操作 → end（即使主问还没问完）', () => {
  const now = Date.now();
  const s = snap('quick', { turns: [q(1, 1, 'p1')], lastQuestionAt: now - 21 * 60 * 1000 });
  const r = decide(s, null, now);
  assert.equal(r.decision, 'end');
  assert.match(r.reason, /无操作/);
});

test('规则 6：预算 30 次用尽 → end（即使主问还没问完）', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1')], callCount: HARD_LIMITS.maxCallsPerSession });
  const r = decide(s, null, Date.now());
  assert.equal(r.decision, 'end');
  assert.match(r.reason, /预算/);
});

test('规则 4：追问与上一条重复(>0.8) → 强制结束本轮（啃不动就换人）', () => {
  const s = snap('full', {
    turns: [q(1, 1, 'p1'), f(2, 1, 'p1', '这个检索服务是同步还是异步')],
  });
  const r = decide(s, { followup: { question: '这个检索服务是同步还是异步的呢', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /重复/);
});

test('全局去重：追问指向别的主问已问过的 claim → 换下一个点', () => {
  const s = snap('quick', {
    turns: [q(1, 1, 'p1'), q(2, 2, 'p2')],
    askedClaimIds: ['c1', 'c2'],
  });
  const r = decide(s, { followup: { question: '换个问法再问一次', target_claim_id: 'c1', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /已问过/);
});

test('规则 2：resolved=true → 结束本轮（即便还能追问）', () => {
  const s = snap('full', { turns: [q(1, 1, 'p1')] });
  const r = decide(s, { followup: { question: '已经答清了就不追了', target_claim_id: 'c9', resolved: true } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /resolved/);
});

test('规则 1：模型不给追问（followup=null）→ 下一问', () => {
  const s = snap('full', { turns: [q(1, 1, 'p1')] });
  assert.equal(decide(s, { followup: null }, Date.now()).decision, 'ask');
});

test('允许追问：条件都满足 → followup', () => {
  const s = snap('full', { turns: [q(1, 1, 'p1')] });
  const r = decide(s, { followup: { question: '那这个 92% 的分母到底是多少', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'followup');
});

test('judge 为 null（判分失败）→ 走规则 1，流程继续不卡死', () => {
  // 【关键】判分模型挂了不能让用户卡在一个答完的问题上。
  // 规则 1 把 null 当"本轮无追问"，于是流程照常推进到下一问。
  const s = snap('quick', { turns: [q(1, 1, 'p1')] });
  const r = decide(s, null, Date.now());
  assert.equal(r.decision, 'ask');
});

// ─────────────────────────── progressOf ───────────────────────────

test('progressOf(state.ts)：追问不推进"第几问"（只看主问）', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1'), f(2, 1, 'p1')] });
  const p = progressOf(s, 3);
  assert.equal(p.mains, 1, '追问不推进主问进度');
  assert.equal(p.round, 2, '但总轮次算上追问');
  assert.equal(p.totalPlanned, 3);
});

test('progressOf(state.ts)：已问完 3 个主问时 qIndex 停在最后一问，不越界成 4', () => {
  const s = snap('quick', { turns: [q(1, 1, 'p1'), q(2, 2, 'p2'), q(3, 3, 'p3')] });
  const p = progressOf(s, 3);
  assert.equal(p.qIndex, 3, '前端显示「3/3」而不是「4/3」');
  assert.equal(p.mains, 3);
  assert.equal(p.qTotal, 3);
});

// ─────────────────────────── 兜底句 ───────────────────────────

test('追问失败兜底句存在且是可读中文（SSE error 用）', () => {
  assert.equal(typeof FALLBACK_FOLLOWUP, 'string');
  assert.ok(FALLBACK_FOLLOWUP.length >= 8);
  assert.match(FALLBACK_FOLLOWUP, /评委/);
});
