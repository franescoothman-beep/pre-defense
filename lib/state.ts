// lib/state.ts —— 会话状态机 + 七条收敛规则（纯函数，结束权在代码不在模型）
export type SessionMode = 'quick' | 'full' | 'single' | 'drill' | 'revise';

export type Turn = {
  seq: number;
  round: number;
  kind: 'question' | 'followup';
  personaId: string;
  targetClaimId: string | null;
  question: string;
};

export type SessionSnapshot = {
  mode: SessionMode;
  state: 'CREATED' | 'PARSED' | 'CLAIMS_READY' | 'PERSONAS_READY' | 'ASKING' | 'ANSWERED' | 'ENDED' | 'REPORTED';
  turns: Turn[];
  askedClaimIds: string[];
  callCount: number;
  lastQuestionAt: number | null;
  startedAt: number;
};

export type Decision = 'ask' | 'followup' | 'end';

export type JudgeOutput = {
  followup: { question: string; target_claim_id: string; resolved: boolean } | null;
};

export const HARD_LIMITS = {
  perPersonaFollowups: 2,
  totalTurns: 15,
  idleMs: 20 * 60 * 1000,
  callTimeoutMs: 30_000,
  maxCallsPerSession: 30,
  maxConcurrentCalls: 2,
} as const;

/** mode 矩阵：轮次与每位评委的主问数（C11/C17） */
export const MODE_MATRIX: Record<SessionMode, { judges: number; mainsEach: number; followupsEach: number; maxTurns: number; label: string }> = {
  quick: { judges: 3, mainsEach: 1, followupsEach: 0, maxTurns: 6, label: '快速评审（3 位各 1 问）' },
  full: { judges: 3, mainsEach: 3, followupsEach: 2, maxTurns: 15, label: '完整体检（3 位各 3 问）' },
  single: { judges: 1, mainsEach: 3, followupsEach: 2, maxTurns: 6, label: '单考官（降级）' },
  drill: { judges: 3, mainsEach: 2, followupsEach: 1, maxTurns: 5, label: '同一材料练回答' },
  revise: { judges: 3, mainsEach: 1, followupsEach: 0, maxTurns: 6, label: '改后材料重新送审' },
};

/** 第 4 条规则用的相似度阈值（避免把函数依赖倒灌进 state.ts） */
const SIM_DUP = 0.8;

function almostSame(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, ''), y = b.replace(/\s+/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const m = x.length, n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n) > SIM_DUP;
}

/**
 * 七条收敛规则。输入快照 + 模型输出，输出下一步动作。
 * 任何一条命中都会让流程前进，永不返回"再等等"。
 */
export function decide(
  snap: SessionSnapshot,
  judge: JudgeOutput | null,
  now: number,
): { decision: Decision; reason: string } {
  const cfg = MODE_MATRIX[snap.mode];
  const followupsInRound = snap.turns.filter((t) => t.round === currentRound(snap) && t.kind === 'followup').length;
  const totalTurns = snap.turns.length;

  // 规则 6：预算
  if (snap.callCount >= HARD_LIMITS.maxCallsPerSession) return { decision: 'end', reason: '预算 30 次用尽' };

  // 规则 7：mode 轮次上限
  if (totalTurns >= cfg.maxTurns) return { decision: 'end', reason: `达到 ${snap.mode} 轮次上限 ${cfg.maxTurns}` };

  // 规则 5：空闲超时
  if (snap.lastQuestionAt !== null && now - snap.lastQuestionAt > HARD_LIMITS.idleMs) {
    return { decision: 'end', reason: '20 分钟无操作' };
  }

  // 规则 1：模型不给追问
  if (!judge || judge.followup === null) return { decision: 'ask', reason: '本轮无追问 → 下一位/下一问' };

  // 规则 2：模型判定已解决
  if (judge.followup.resolved) return { decision: 'ask', reason: 'resolved=true → 结束本轮' };

  // 规则 3：追问次数已达上限
  if (followupsInRound >= HARD_LIMITS.perPersonaFollowups || followupsInRound >= cfg.followupsEach) {
    return { decision: 'ask', reason: `追问已达 ${cfg.followupsEach} 轮上限` };
  }

  // 规则 4：与上一条问题几乎重复
  const last = [...snap.turns].reverse().find((t) => t.kind === 'followup');
  if (last && almostSame(last.question, judge.followup.question)) {
    return { decision: 'ask', reason: '追问与上一条重复(>0.8) → 强制结束' };
  }

  // 全局去重：同一个 claim 在本场只能被追一次（否则仨评委围着同一个点问三遍）
  if (judge.followup.target_claim_id && snap.askedClaimIds.includes(judge.followup.target_claim_id)) {
    return { decision: 'ask', reason: '该 claim 已问过 → 换下一个点' };
  }

  return { decision: 'followup', reason: '允许追问' };
}

export function currentRound(snap: SessionSnapshot): number {
  const last = snap.turns[snap.turns.length - 1];
  return last ? last.round : 1;
}

/** 是否该换评委：每位评委的主问数用完后换下一位 */
export function shouldSwitchPersona(snap: SessionSnapshot, judgeCount: number): boolean {
  const cfg = MODE_MATRIX[snap.mode];
  const mains = snap.turns.filter((t) => t.kind === 'question').length;
  const finished = Math.floor(mains / cfg.mainsEach);
  return finished >= Math.min(judgeCount, cfg.judges);
}

/** 是否整场结束（所有评委都问完 + 到上限） */
export function isFinished(snap: SessionSnapshot, judgeCount: number): boolean {
  const cfg = MODE_MATRIX[snap.mode];
  if (snap.turns.length >= cfg.maxTurns) return true;
  const mainsNeeded = Math.min(judgeCount, cfg.judges) * cfg.mainsEach;
  const mains = snap.turns.filter((t) => t.kind === 'question').length;
  return mains >= mainsNeeded;
}

/** UI 用：进度（第几位 · 第几问 · 已覆盖维度） */
export function progressOf(snap: SessionSnapshot, judgeCount = 3) {
  const cfg = MODE_MATRIX[snap.mode];
  const mains = snap.turns.filter((t) => t.kind === 'question').length;
  const followups = snap.turns.filter((t) => t.kind === 'followup').length;
  return {
    round: mains + followups,
    totalPlanned: Math.min(judgeCount, cfg.judges) * cfg.mainsEach,
    personaIndex: Math.min(Math.floor(mains / cfg.mainsEach) + 1, Math.min(judgeCount, cfg.judges)),
    label: `${MODE_MATRIX[snap.mode].label} · ${mains + followups}/${cfg.maxTurns} 轮`,
  };
}
