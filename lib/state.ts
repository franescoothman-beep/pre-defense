// lib/state.ts —— 会话状态机 + 收敛规则（纯函数，结束权在代码不在模型）
//
// 【这一版改了三件事，每一件都对应一个真实会踩到的坑】
//
// ① `round` 的语义从「第几个 turn」改成「第几个主问」。
//    旧实现里 stream 路由用 `Math.ceil(seq / judges)` 算 round，quick 档 seq=1,2,3 全落在 round 1，
//    seq=4 才变 2 —— 于是「本轮已追问几次」永远算不对：第 3 问的追问会被当成第 1 问的追问，
//    追问配额于是要么用不完、要么提前用光。现在 round = 主问序号 + 1，追问继承它所属主问的 round。
//
// ② `mode=quick` 的 `followupsEach` 从 0 改成 1。
//    文档写的是「quick 3–6 轮出报告」：3 位各 1 主问 + 至多 1 次追问 = 3–6 轮才对得上。
//    旧值 0 意味着 quick 档**永远不会有追问** —— 而 quick 是默认档，也就是演示与录屏走的档。
//    「轮番提问与追问」是这个产品的名字的一半，默认档里一次追问都没有，产品看起来就是半成品。
//
// ③ 新增「主问配额用尽即收口」。
//    这是 C11「报告永不缺席」的落点，也是 DoD「第 3 问结束后必然进报告」的落点。
//    规则 7 只管「轮次上限」（流程安全），这一条管「主问已问完」（业务完成）——
//    两者宁可分开写，也不要让「轮次上限」一个数字同时承担两种含义。
//

export type SessionMode = 'quick' | 'full' | 'single' | 'drill' | 'revise';

export type Turn = {
  seq: number;
  /**
   * 主问序号（1 起）。追问继承所属主问的 round。
   * 用途：规则 3「本轮追问次数」与 UI 的「第几问」必须用同一个口径。
   */
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
  /**
   * 实际到场的评委数。材料维度不足时可能只有 2 位（见 personas.v1 的 planSeats），
   * 缺省按 mode 的理论值算 —— 但**判断「问完没有」必须用实际值**，
   * 否则 2 位评委的场子永远等不到第 3 位，会一直空转到轮次上限。
   */
  judges?: number;
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
  quick: { judges: 3, mainsEach: 1, followupsEach: 1, maxTurns: 6, label: '快速评审（3 位各 1 问）' },
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

/** 实际到场评委数（按 mode 上限截断） */
export function judgesOf(snap: { mode: SessionMode; judges?: number }): number {
  const cfg = MODE_MATRIX[snap.mode];
  const n = snap.judges ?? cfg.judges;
  return Math.max(1, Math.min(n, cfg.judges));
}

/** 本场一共要问多少个**主问**（追问不计入） */
export function mainsNeededOf(snap: { mode: SessionMode; judges?: number }): number {
  return judgesOf(snap) * MODE_MATRIX[snap.mode].mainsEach;
}

/**
 * 已经问过多少个主问（含还在等回答的那一问）。
 *
 * 入参只要求 `kind`，因为调用方手里的往往是 DB 行（`kind: string`）而不是 Turn。
 * 让状态机认 DB 行、不认 Turn 类型，可以避免每个路由都做一次无意义的映射。
 */
export function mainsDoneOf(turns: Array<{ kind: string }>): number {
  return turns.filter((t) => t.kind === 'question').length;
}

/**
 * 第 mainIndex（0 起）个主问该由第几位评委问。
 *
 * quick：mainsEach=1 → 0,1,2 → 评委 0,1,2（一问换一位）
 * full ：mainsEach=3 → 0,1,2 → 评委 0；3,4,5 → 评委 1；6,7,8 → 评委 2（三问换一位）
 *
 * 【为什么必须写成函数】旧的 stream 路由用 `personas[answered % personas.length]`，
 * answered 把**追问**也算进去了 —— 一旦某位评委追问过一次，下一位主问就会跳到第三位评委，
 * 结果第三位评委一次也没问、第二位被问了两轮。这是一个只在「真的发生追问」时才出现、
 * mock 下单跑三次首问永远看不见的错位。
 */
export function personaIndexOfMain(mainIndex: number, mainsEach: number, judges: number): number {
  const seat = Math.floor(mainIndex / Math.max(1, mainsEach));
  return Math.max(0, Math.min(seat, judges - 1));
}

/**
 * 收敛规则。输入快照 + 模型输出，输出下一步动作。
 * 任何一条命中都会让流程前进，永不返回"再等等"。
 */
export function decide(
  snap: SessionSnapshot,
  judge: JudgeOutput | null,
  now: number,
): { decision: Decision; reason: string } {
  const cfg = MODE_MATRIX[snap.mode];
  const round = currentRound(snap);
  const followupsInRound = snap.turns.filter((t) => t.round === round && t.kind === 'followup').length;
  const totalTurns = snap.turns.length;
  const judges = judgesOf(snap);
  const mainsDone = mainsDoneOf(snap.turns);
  const mainsNeeded = mainsNeededOf(snap);

  // 规则 6：预算
  if (snap.callCount >= HARD_LIMITS.maxCallsPerSession) return { decision: 'end', reason: '预算 30 次用尽' };

  // 规则 7：mode 轮次上限
  if (totalTurns >= cfg.maxTurns) return { decision: 'end', reason: `达到 ${snap.mode} 轮次上限 ${cfg.maxTurns}` };

  // 规则 5：空闲超时
  if (snap.lastQuestionAt !== null && now - snap.lastQuestionAt > HARD_LIMITS.idleMs) {
    return { decision: 'end', reason: '20 分钟无操作' };
  }

  // 规则 7 的姐妹条款：主问配额用尽 → 立刻收口（C11 报告永不缺席）
  // 【为什么放在「无追问」之前】主问都问完了，再追问就是"超出计划的开销"：
  // 报告已经可以写（每个维度都至少被问过一次），继续问只会让用户多等一轮。
  if (mainsDone >= mainsNeeded) {
    return { decision: 'end', reason: `主问已问完（${mainsDone}/${mainsNeeded}）→ 立刻出报告` };
  }

  // 规则 1：模型不给追问
  if (!judge || judge.followup === null) return { decision: 'ask', reason: '本轮无追问 → 下一位/下一问' };

  // 规则 2：模型判定已解决
  if (judge.followup.resolved) return { decision: 'ask', reason: 'resolved=true → 结束本轮' };

  // 规则 3：追问次数已达上限（实际值 judges 与 mode 上限取小）
  if (followupsInRound >= Math.min(HARD_LIMITS.perPersonaFollowups, cfg.followupsEach)) {
    return { decision: 'ask', reason: `本轮追问已达 ${Math.min(HARD_LIMITS.perPersonaFollowups, cfg.followupsEach)} 次上限` };
  }

  // 规则 4：与上一条追问几乎重复
  const last = [...snap.turns].reverse().find((t) => t.kind === 'followup');
  if (last && almostSame(last.question, judge.followup.question)) {
    return { decision: 'ask', reason: '追问与上一条重复(>0.8) → 强制结束' };
  }

  // 全局去重：同一个 claim 在本场只能被 targeting 一次
  // （否则仨评委围着同一个点问三遍，quick 档 3 问问出 1 个信息点）
  if (judge.followup.target_claim_id && snap.askedClaimIds.includes(judge.followup.target_claim_id)) {
    return { decision: 'ask', reason: '该 claim 已问过 → 换下一个点' };
  }

  void judges;
  return { decision: 'followup', reason: '允许追问' };
}

export function currentRound(snap: SessionSnapshot): number {
  const last = snap.turns[snap.turns.length - 1];
  return last ? last.round : 1;
}

/**
 * 是否该换评委：每位的**主问**配额用完就换下一位。
 *
 * 【注意这里只数 kind==='question'】追问不推进评委轮转——
 * 追问是"同一位评委咬住不放"，把它算进轮转等于强迫评委问一句就走。
 */
export function shouldSwitchPersona(snap: SessionSnapshot, judgeCount: number): boolean {
  const cfg = MODE_MATRIX[snap.mode];
  const judges = Math.max(1, Math.min(judgeCount, cfg.judges));
  return mainsDoneOf(snap.turns) >= judges * cfg.mainsEach;
}

/** 是否整场结束（主问问完 或 到轮次上限） */
export function isFinished(snap: SessionSnapshot, judgeCount?: number): boolean {
  const cfg = MODE_MATRIX[snap.mode];
  if (snap.turns.length >= cfg.maxTurns) return true;
  const judges = judgeCountOverride(snap, judgeCount);
  return mainsDoneOf(snap.turns) >= judges * cfg.mainsEach;
}

function judgeCountOverride(snap: SessionSnapshot, judgeCount?: number): number {
  const cfg = MODE_MATRIX[snap.mode];
  const n = judgeCount ?? snap.judges ?? cfg.judges;
  return Math.max(1, Math.min(n, cfg.judges));
}

/**
 * UI 用：进度（第几位 · 第几问 主问进度）。
 *
 * 【与 lib/session.ts 的 progressOf 的区别 —— 这是两个不同的函数，名字撞了】
 *   state.progressOf   ：纯函数，入参是内存里的 snapshot，不查库。给单测与状态机用。
 *   session.progressOf ：查库版，入参是 SessionRow，会读 turns / personas。
 * 两者返回**同一个结构的子集**是刻意的：调用方拼 UI 时不该因为"数据从哪来"而拿到不同字段。
 * 所以这里也带 `qIndex` / `qTotal`（曾经只有 session 版有，导致路由与测试各写一套取字段逻辑）。
 */
export function progressOf(snap: SessionSnapshot, judgeCount?: number) {
  const cfg = MODE_MATRIX[snap.mode];
  const judges = judgeCountOverride(snap, judgeCount);
  const mains = mainsDoneOf(snap.turns);
  const followups = snap.turns.filter((t) => t.kind === 'followup').length;
  const qTotal = Math.min(cfg.maxTurns, judges * cfg.mainsEach);
  return {
    round: mains + followups,
    mains,
    mainsPlanned: judges * cfg.mainsEach,
    totalPlanned: judges * cfg.mainsEach,
    qTotal,
    // 已问完时停在最后一问（不越界成"4/3"）
    qIndex: Math.min(mains + 1, qTotal || 1),
    personaIndex: Math.min(personaIndexOfMain(Math.min(mains, judges * cfg.mainsEach - 1), cfg.mainsEach, judges) + 1, judges),
    label: `${cfg.label} · ${mains + followups}/${cfg.maxTurns} 轮`,
  };
}

/** 追问失败时的兜底句（SSE error / 前端提示用；模型挂了也要有话说） */
export const FALLBACK_FOLLOWUP = '（评委这次没能接上追问，接着答下一问即可）';
