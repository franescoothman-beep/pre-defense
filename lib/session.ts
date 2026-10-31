// lib/session.ts —— 会话读取与"当前该问什么"的装配（纯查询，无 LLM 调用）
//
// 放在 lib/ 而不是路由里的原因（§3.6 路由层禁令）：
//   SSE 路由、GET /api/sessions/:id、未来的 /next 都要按同一套规则算出"现在轮到谁、问第几问、
//   锚点在哪"。三处各写一遍必然分叉，而分叉的第一现场就是"聊天页显示的评委和 SSE 说的评委不是同一位"。
//
// 这一层只做**读**：不写库、不调模型、不推进状态。状态推进留给 /answer 与 /next。

import { q } from './db';
import { MODE_MATRIX, type SessionMode } from './state';

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
  targetClaimId: string | null;
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
    `select id, seq, round, kind, persona_id, question, answer, target_claim_id
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
    targetClaimId:
      // 迁移前的旧 turn 这列是 undefined（不是 null），必须一起当"没有"处理，
      // 否则 `String(undefined)` 会得到字符串 "undefined"，被当成一个真实的 claim id 去查库。
      r.target_claim_id === null || r.target_claim_id === undefined
        ? null
        : String(r.target_claim_id),
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

/** 该质疑点所引用的 claim 之下，共有几条候选引用（L5 的"已检索 N 处候选引用"） */
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

/** 会话进度：第几问 / 共几问 / 当前轮到第几位评委 */
export type Progress = {
  qIndex: number;
  qTotal: number;
  personaIndex: number;
  personaCount: number;
  answered: number;
};

export function progressOf(session: SessionRow): Progress {
  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const turns = loadTurns(session.id);
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  const answered = turns.filter((t) => t.answer !== null && t.answer !== '').length;

  // 主问数 = 每位评委 mainsEach 问；quick 档 3 位 × 1 问 = 3
  const qTotal = Math.min(matrix.maxTurns, personas.length * matrix.mainsEach);

  return {
    // qIndex 是"当前要问的是第几问"，从 1 开始；已回答完 answered 个
    qIndex: Math.min(answered + 1, qTotal || 1),
    qTotal,
    personaIndex: personas.length === 0 ? 0 : answered % personas.length,
    personaCount: personas.length,
    answered,
  };
}

/**
 * 当前该发问的评委 + 锚点。
 *
 * 规则（与 §2.3 状态机一致，且**结束权在代码不在模型**）：
 *   - 还没回答的 turn 存在 → 就是那一问（说明这一问已经生成过，SSE 只是重新播放）
 *   - 否则取下一位评委（按 answered 取模轮转）
 *   - 会话已 ENDED / REPORTED → null（SSE 直接发 done，不再生成问题）
 */
export type CurrentQuestion = {
  persona: PersonaRow;
  claimId: string | null;
  anchor: ClaimAnchor | null;
  progress: Progress;
};

export function currentQuestion(session: SessionRow): CurrentQuestion | null {
  if (session.state === 'ENDED' || session.state === 'REPORTED') return null;

  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  if (personas.length === 0) return null;

  const turns = loadTurns(session.id);

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
      progress,
    };
  }

  // 新的一问：由下一轮的 /next 决定锚点；SSE 只负责把"轮到谁"说清楚
  const persona = personas[progress.answered % personas.length];
  return { persona, claimId: null, anchor: null, progress };
}
