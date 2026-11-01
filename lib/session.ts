// lib/session.ts —— 会话读取与"当前该问什么"的装配（不调 LLM 的查询层）
//
// 放在 lib/ 而不是路由里的原因（§3.6 路由层禁令）：
//   SSE 路由、GET /api/sessions/:id、/answer、/next 都要按同一套规则算出
//   "现在轮到谁、问第几问、锚点在哪"。四处各写一遍必然分叉，
//   而分叉的第一现场就是"聊天页显示的评委和 SSE 说的评委不是同一位"。
//
// 这一层只做**读**：不调模型、不推进状态。写库留给路由（/answer、/next、/end）。
//
// 【2026-11-01 修正的两个轮转错位】
//   ① 旧 `progress.qIndex = answered + 1`：answered 把追问也算进去，
//      于是答完一次追问后 qIndex 会跳过一位（"第 2 问"直接跳到"第 4 问"）。
//      现在 qIndex 只数主问。
//   ② 旧 `personaIndex = answered % personas.length`：同理会因为追问而错位。
//      现在按 `personaIndexOfMain(主问序号)` 算，追问不推进评委。
//   这两个错位只在"真的发生追问"时出现——mock 单跑三次首问永远看不见。

import { q } from './db';
import {
  MODE_MATRIX,
  personaIndexOfMain,
  mainsDoneOf,
  judgesOf,
  type SessionMode,
} from './state';

export type SessionRow = {
  id: string;
  docId: string;
  mode: SessionMode;
  state: string;
  drillFrom: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type PersonaRow = {
  id: string;
  name: string;
  role: string;
  focus: string;
  tone: string;
  color: string;
  /** 这位评委盯哪个面（排席位时定下的，决定横条标签的四维传统色） */
  dimension: 'logic' | 'evidence' | 'depth' | 'expression' | null;
};

export type ClaimAnchor = {
  claimId: string;
  blockIdx: number;
  page: number | null;
  section: string | null;
  quote: string;
  locatorKind: 'quote' | 'absence';
  verified: 0 | 1 | null;
  /** 该 block 的完整原文（扫读思考态要显示"评委正在读的那两句"） */
  source: string;
};

export type TurnRow = {
  id: string;
  seq: number;
  round: number;
  kind: string;
  personaId: string;
  question: string;
  answer: string | null;
  score: number | null;
  gaps: string | null;
  locators: string | null;
  verifiedOk: number | null;
  targetClaimId: string | null;
  createdAt: string | null;
};

export function loadSession(sessionId: string): SessionRow | null {
  const r = q.get(
    `select id, doc_id, mode, state, drill_from, started_at, ended_at from sessions where id = ?`,
    sessionId,
  );
  if (!r) return null;
  return {
    id: String(r.id),
    docId: String(r.doc_id),
    mode: String(r.mode) as SessionMode,
    state: String(r.state),
    drillFrom: r.drill_from === null ? null : String(r.drill_from),
    startedAt: String(r.started_at),
    endedAt: r.ended_at === null ? null : String(r.ended_at),
  };
}

/**
 * 取这一场的评委。
 *
 * 三级取法（每一级都对应一个真实会发生的场景）：
 *   ① 按 session_id —— 正常路径（人设属于"这一场"）
 *   ② 按 doc_id 且 session_id 为 NULL —— 升级前的旧会话（迁移当时还没有这一列）
 *   ③ 按 doc_id 最近一批 —— **兜底**：会话存在但人设没挂上 session_id
 *      （例如脚本直接插 sessions 表、或迁移中断）。若不兜底，
 *      页面会显示"这场会话没有评委"，而库里的评委其实好好的。
 *      兜底必须带 limit，否则同一 doc 的多轮人设会一起返回，
 *      让"当前第几位评委"的取模彻底错位。
 */
export function loadPersonas(sessionId: string, docId: string, limit?: number): PersonaRow[] {
  const cols = `id, name, role, focus, tone, color, dimension`;
  const mine = q.all(
    `select ${cols} from personas
     where session_id = ? order by created_at, rowid`,
    sessionId,
  );
  if (mine.length > 0) {
    const mapped = mine.map(mapPersonaRow);
    return limit === undefined ? mapped : mapped.slice(0, limit);
  }

  // ② 旧会话（session_id 列为 NULL）
  const legacy = q.all(
    `select ${cols} from personas
     where doc_id = ? and (session_id is null) order by created_at desc, rowid`,
    docId,
  );
  if (legacy.length > 0) {
    const mapped = legacy.map(mapPersonaRow);
    return limit === undefined ? mapped : mapped.slice(0, limit);
  }

  // ③ 兜底：按 doc 取最近一批，并明确告警（这不是正常路径，要能在日志里看到）
  console.warn(
    `[loadPersonas] 会话 ${sessionId} 没有挂上任何人设，回退到按 doc ${docId} 取最近一批。` +
      `若这是正常建的会话，说明写 personas 时漏了 session_id。`,
  );
  const fallback = q.all(
    `select ${cols} from personas where doc_id = ? order by created_at desc, rowid`,
    docId,
  );
  const mapped = fallback.map(mapPersonaRow);
  return limit === undefined ? mapped : mapped.slice(0, limit);
}

/** 行 → PersonaRow。dimension 为旧数据兜底：迁移前的行该列为 NULL，返回 null 由展示层处理。 */
function mapPersonaRow(r: Record<string, unknown>): PersonaRow {
  return {
    id: String(r.id),
    name: String(r.name),
    role: String(r.role),
    focus: String(r.focus),
    tone: String(r.tone),
    color: String(r.color),
    dimension:
      r.dimension === null || r.dimension === undefined
        ? null
        : (String(r.dimension) as PersonaRow['dimension']),
  };
}

/** 兼容旧调用点（按 doc 取）。新代码请用 loadPersonas(sessionId, docId, limit)。 */
export function loadPersonasOfDoc(docId: string, limit?: number): PersonaRow[] {
  const rows = q.all(
    `select id, name, role, focus, tone, color, dimension from personas
     where doc_id = ? order by created_at, rowid`,
    docId,
  );
  const mapped = rows.map(mapPersonaRow);
  return limit === undefined ? mapped : mapped.slice(0, limit);
}

export function loadTurns(sessionId: string): TurnRow[] {
  const rows = q.all(
    `select id, seq, round, kind, persona_id, question, answer, score, gaps, locators,
            verified_ok, target_claim_id, created_at
     from turns where session_id = ? order by seq`,
    sessionId,
  );
  return rows.map((r) => ({
    id: String(r.id),
    seq: Number(r.seq),
    round: Number(r.round),
    kind: String(r.kind),
    personaId: String(r.persona_id),
    question: String(r.question),
    answer: r.answer === null ? null : String(r.answer),
    score: r.score === null || r.score === undefined ? null : Number(r.score),
    gaps: r.gaps === null || r.gaps === undefined ? null : String(r.gaps),
    locators: r.locators === null || r.locators === undefined ? null : String(r.locators),
    verifiedOk: r.verified_ok === null || r.verified_ok === undefined ? null : Number(r.verified_ok),
    targetClaimId:
      // 迁移前的旧 turn 这列是 undefined（不是 null），必须一起当"没有"处理，
      // 否则 `String(undefined)` 会得到字符串 "undefined"，被当成一个真实的 claim id 去查库。
      r.target_claim_id === null || r.target_claim_id === undefined
        ? null
        : String(r.target_claim_id),
    createdAt: r.created_at === null || r.created_at === undefined ? null : String(r.created_at),
  }));
}

/**
 * 这份材料总共有多少可扫读的文本块。
 *
 * 用途：L5 扫读原文思考态要显示 `BLOCK 19/42` —— 42 就是这个值。
 * 为什么由服务端算：前端为了显示一个总数去拉全部 blocks 是浪费（101 页论文有 2437 块），
 * 而且"总块数"属于材料自身的属性，和"这一段原文是什么"是同源数据，一起给才不会出现
 * "显示的块号比总数还大"这种自相矛盾的画面。
 */
export function blockCountOf(docId: string): number {
  const r = q.get(`select count(*) as n from blocks where doc_id = ?`, docId);
  return Number(r?.n ?? 0);
}

/** 该维度下共有几条候选引用（L5 的"已检索 N 处候选引用"） */
export function candidateCountOf(docId: string, dimension: string | null): number {
  const r = dimension
    ? q.get(`select count(*) as n from claims where doc_id = ? and dimension = ?`, docId, dimension)
    : q.get(`select count(*) as n from claims where doc_id = ?`, docId);
  return Number(r?.n ?? 0);
}

/**
 * 取某条 claim 的锚点（含 block 原文）。
 *
 * 「含 block 原文」这一点是 L5 扫读思考态的唯一数据来源：
 * 只给 quote 的话，前端只能显示被引用的那一句；给整块原文，才能显示
 * 「评委正在读的这两行」——那是"这个产品无法被替换成别的产品"的地方。
 */
export function loadAnchor(claimId: string): ClaimAnchor | null {
  const c = q.get(
    `select id, doc_id, block_idx, page, section, quote, locator_kind, verified from claims where id = ?`,
    claimId,
  );
  if (!c) return null;

  const b = q.get(`select text from blocks where doc_id = ? and idx = ?`, String(c.doc_id), Number(c.block_idx));

  return {
    claimId: String(c.id),
    blockIdx: Number(c.block_idx),
    page: c.page === null ? null : Number(c.page),
    section: c.section === null ? null : String(c.section),
    quote: String(c.quote ?? ''),
    locatorKind: String(c.locator_kind) as 'quote' | 'absence',
    verified: c.verified === null ? null : (Number(c.verified) as 0 | 1),
    source: b ? String(b.text) : '',
  };
}

/** 会话进度：第几问（只数主问）/ 共几问 / 当前轮到第几位评委 */
export type Progress = {
  /** 当前要问的是第几个主问（1 起）；已问完时停在最后一位 */
  qIndex: number;
  qTotal: number;
  /** 0 起的评委下标（前端按它定位横条；null 表示这场没有评委） */
  personaIndex: number;
  personaCount: number;
  /** 已作答的 turn 数（含追问，仅用于展示"已答 N 次"） */
  answered: number;
  /** 已问完的主问数（UII 的 "第 2/3 问"） */
  mains: number;
};

export function progressOf(session: SessionRow): Progress {
  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const turns = loadTurns(session.id);
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  const personaCount = Math.min(personas.length || matrix.judges, matrix.judges);
  const answered = turns.filter((t) => t.answer !== null && t.answer !== '').length;
  const mains = mainsDoneOf(turns);
  const mainsEach = matrix.mainsEach;
  const qTotal = Math.min(matrix.maxTurns, personaCount * mainsEach);

  const nextMainIndex = Math.min(mains, Math.max(0, qTotal - 1));
  return {
    // qIndex 是新口径：只数主问。答完一次追问不会让"第几问"跳号。
    qIndex: Math.min(mains + 1, qTotal || 1),
    qTotal,
    personaIndex: personaIndexOfMain(nextMainIndex, mainsEach, personaCount),
    personaCount,
    answered,
    mains,
  };
}

/**
 * 当前该发问的评委 + 锚点。
 *
 * 规则（与 §3.8 状态机一致，且**结束权在代码不在模型**）：
 *   - 还没回答的 turn 存在 → 就是那一问（说明这一问已经生成过，SSE 只是重新播放）
 *   - 否则取下一位评委（按主问序号轮转，追问不推进评委）
 *   - 会话已 ENDED / REPORTED → null（SSE 直接发 done，不再生成问题）
 */
export type CurrentQuestion = {
  persona: PersonaRow;
  claimId: string | null;
  anchor: ClaimAnchor | null;
  source: string | null;
  progress: Progress;
  /** 已有的待回答 turn（重播路径用；null 表示这是全新一问，需要生成） */
  pendingTurnId: string | null;
  /**
   * 这一问是不是在「咬住同一条质疑点」的追问。
   * 前端据此决定要不要显示「（追问）」标记——不标的话，用户会以为评委问重了。
   */
  isFollowup: boolean;
  /** 追问时继承的主问轮次（写库用） */
  round: number;
};

export function currentQuestion(session: SessionRow): CurrentQuestion | null {
  if (session.state === 'ENDED' || session.state === 'REPORTED') return null;

  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  if (personas.length === 0) return null;

  const turns = loadTurns(session.id);
  const personaCount = Math.min(personas.length, matrix.judges);

  /**
   * "待回答"的 turn 必须**同时**满足两条：
   *   ① 问题已经生成出来了（question 非空）
   *   ② 用户还没答（answer 空）
   *
   * 为什么不能只看 answer：SSE 出题是先建一个占位 turn，再流式往里填问题。
   * 若用户在这一步刷新页面/断网，库里会留下一条 answer 为空、question 也为空的 turn。
   * 只看 answer 的话，这条半成品会被当成"有一个问题等着你答"，
   * 于是重连时把空字符串当作问题重播给前端 —— 界面上是一条**空白的评委发言**。
   * 这种 turn 应当视为"没发生过"，重新生成。
   */
  const pending = turns.find(
    (t) => (t.answer === null || t.answer === '') && t.question !== null && t.question !== '',
  );
  const progress = progressOf(session);

  if (pending) {
    const persona = personas.find((p) => p.id === pending.personaId) ?? personas[0];
    return {
      persona,
      claimId: pending.targetClaimId,
      anchor: pending.targetClaimId ? loadAnchor(pending.targetClaimId) : null,
      source: null,
      pendingTurnId: pending.id,
      progress,
      isFollowup: pending.kind === 'followup',
      round: pending.round,
    };
  }

  // 新的一问：轮到哪位评委由「已问完的主问数」决定，追问不推进评委
  const mains = mainsDoneOf(turns);
  const seat = personaIndexOfMain(mains, matrix.mainsEach, personaCount);
  const persona = personas[seat] ?? personas[0];
  return {
    persona,
    claimId: null,
    anchor: null,
    source: null,
    pendingTurnId: null,
    progress,
    isFollowup: false,
    round: mains + 1,
  };
}

/**
 * 本场**已 targeting 过**的 claim（全局去重基准）。
 *
 * 【为什么排除本主问的那条】追问的本质是咬住同一条质疑点再深一层。
 * 若把本主问的 claim 也算作"已问过"，追问会被去重规则当场打死，
 * quick 档永远追不出来——而追问正是产品的名字的一半。
 * 排除规则由调用方传入 currentTurnId 来划定。
 */
export function askedClaimIdsOf(sessionId: string, exceptTurnId?: string | null): string[] {
  const rows = exceptTurnId
    ? q.all(
        `select distinct target_claim_id from turns
         where session_id = ? and target_claim_id is not null and id != ?`,
        sessionId, exceptTurnId,
      )
    : q.all(
        `select distinct target_claim_id from turns
         where session_id = ? and target_claim_id is not null`,
        sessionId,
      );
  return (rows as Array<Record<string, unknown>>).map((r) => String(r.target_claim_id));
}

/** 取一份材料的全部 blocks（判分时的机检基准） */
export function loadBlocksOfDoc(docId: string): import('./parse').Block[] {
  const rows = q.all(
    `select idx, page, section, text from blocks where doc_id = ? order by idx`,
    docId,
  );
  return rows.map((r) => ({
    idx: Number(r.idx),
    page: r.page === null ? null : Number(r.page),
    section: r.section === null ? null : String(r.section),
    text: String(r.text),
  }));
}

/** 取一份材料的全部 claim（/next 与 /answer 的追问候选池用） */
export type ClaimRowFull = {
  id: string;
  type: string;
  text: string;
  dimension: string;
  risk: number;
  blockIdx: number;
  page: number | null;
  section: string | null;
  quote: string;
  locatorKind: 'quote' | 'absence';
  verified: 0 | 1 | null;
};

export function loadClaimsOfDoc(docId: string): ClaimRowFull[] {
  const rows = q.all(
    `select id, type, text, dimension, risk, block_idx, page, section, quote, locator_kind, verified
     from claims where doc_id = ? order by risk desc`,
    docId,
  );
  return rows.map((r) => ({
    id: String(r.id),
    type: String(r.type),
    text: String(r.text),
    dimension: String(r.dimension),
    risk: Number(r.risk),
    blockIdx: Number(r.block_idx),
    page: r.page === null ? null : Number(r.page),
    section: r.section === null ? null : String(r.section),
    quote: String(r.quote ?? ''),
    locatorKind: String(r.locator_kind) as 'quote' | 'absence',
    verified: r.verified === null ? null : (Number(r.verified) as 0 | 1),
  }));
}

/** 下一个主问该落到哪条 claim：优先该评委负责的类型，且必须是本场还没问过的 */
export function pickNextClaim(
  sessionId: string,
  claims: ClaimRowFull[],
  personaRole: string,
): ClaimRowFull | null {
  const asked = new Set(askedClaimIdsOf(sessionId));
  const fresh = claims.filter((c) => !asked.has(c.id));
  if (fresh.length === 0) return null;
  return fresh.find((c) => c.type === personaRole) ?? fresh[0];
}

/** 会话的评委实际数量（按 mode 上限截断） */
export function judgeCountOf(session: SessionRow): number {
  const cap = judgesOf({ mode: session.mode });
  const personas = loadPersonas(session.id, session.docId, cap);
  return Math.max(1, Math.min(personas.length || cap, cap));
}
