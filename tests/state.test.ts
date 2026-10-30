import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, MODE_MATRIX, progressOf, isFinished, type SessionSnapshot } from '../lib/state.ts';

function snap(mode: SessionSnapshot['mode'], over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    mode, state: 'ASKING', turns: [], askedClaimIds: [], callCount: 1,
    lastQuestionAt: Date.now(), startedAt: Date.now(), ...over,
  };
}

test('规则 1：模型不给追问 → ask', () => {
  const r = decide(snap('full'), { followup: null }, Date.now());
  assert.equal(r.decision, 'ask');
});

test('规则 2：resolved=true → 结束本轮', () => {
  const r = decide(snap('full'), { followup: { question: '追问一句话', target_claim_id: 'c1', resolved: true } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /resolved/);
});

test('规则 3：已追问 2 轮 → 强制结束', () => {
  const s = snap('full', {
    turns: [
      { seq: 1, round: 1, kind: 'question', personaId: 'p1', targetClaimId: 'c1', question: '主问' },
      { seq: 2, round: 1, kind: 'followup', personaId: 'p1', targetClaimId: 'c1', question: '追问一' },
      { seq: 3, round: 1, kind: 'followup', personaId: 'p1', targetClaimId: 'c1', question: '追问二' },
    ],
  });
  const r = decide(s, { followup: { question: '还想再问一句', target_claim_id: 'c1', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /追问已达/);
});

test('规则 4：追问与上一条重复(>0.8) → 强制结束', () => {
  const s = snap('full', {
    turns: [{ seq: 1, round: 1, kind: 'followup', personaId: 'p1', targetClaimId: 'c1', question: '这个检索服务是同步还是异步' }],
  });
  const r = decide(s, { followup: { question: '这个检索服务是同步还是异步的呢', target_claim_id: 'c2', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /重复/);
});

test('规则 5：20 分钟无操作 → end', () => {
  const now = Date.now();
  const s = snap('full', { lastQuestionAt: now - 21 * 60 * 1000 });
  const r = decide(s, { followup: null }, now);
  assert.equal(r.decision, 'end');
  assert.match(r.reason, /无操作/);
});

test('规则 6：预算 30 次用尽 → end', () => {
  const r = decide(snap('full', { callCount: 30 }), null, Date.now());
  assert.equal(r.decision, 'end');
});

test('规则 7：mode 轮次上限（quick=6）→ end', () => {
  const turns = Array.from({ length: 6 }, (_, i) => ({
    seq: i, round: 1, kind: (i % 2 ? 'followup' : 'question') as 'question' | 'followup',
    personaId: 'p1', targetClaimId: 'c1', question: `q${i}`,
  }));
  const r = decide(snap('quick', { turns }), null, Date.now());
  assert.equal(r.decision, 'end');
  assert.equal(MODE_MATRIX.quick.maxTurns, 6);
});

test('全局去重：同一 claim 已问过 → 换下一个点', () => {
  const s = snap('full', { askedClaimIds: ['c7'] });
  const r = decide(s, { followup: { question: '换个问法再问一次可以吗', target_claim_id: 'c7', resolved: false } }, Date.now());
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /已问过/);
});

test('允许追问：条件都满足 → followup', () => {
  const r = decide(snap('full'), { followup: { question: '那这个 92% 的分母到底是多少', target_claim_id: 'c9', resolved: false } }, Date.now());
  assert.equal(r.decision, 'followup');
});

test('quick 档：3 位各 1 问后 isFinished', () => {
  const s = snap('quick', {
    turns: [1, 2, 3].map((i) => ({
      seq: i, round: 1, kind: 'question' as const, personaId: `p${i}`, targetClaimId: `c${i}`, question: `q${i}`,
    })),
  });
  assert.equal(isFinished(s, 3), true, 'quick 3 问后就该结束并出报告');
});

test('progressOf：给出第几位·第几问', () => {
  const s = snap('quick', {
    turns: [{ seq: 1, round: 1, kind: 'question', personaId: 'p1', targetClaimId: 'c1', question: 'q1' }],
  });
  const p = progressOf(s, 3);
  assert.equal(p.totalPlanned, 3);
  assert.ok(p.label.includes('1/6'));
});
