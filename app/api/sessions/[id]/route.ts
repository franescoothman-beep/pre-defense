// app/api/sessions/[id]/route.ts —— 读取一场会话（§3.6 GET /api/sessions/:id）
//
// 【只读】这条路由不推进状态、不调模型、不写库。
// 它的存在意义：聊天页刷新后要能"回到原样"——评委是谁、轮到第几问、谁已经问过。
// 若让页面自己拼这些，就得在前端复制一遍状态机规则，那是分叉的开始。
//
// 返回：
//   state / mode / modeLabel / docName
//   personas[]（含 dimension，横条要用它选四维传统色）
//   progress{qIndex,qTotal,answered,personaCount}
//   currentPersonaId（谁现在该说话；会话结束则为 null）
//   pastPersonaIds（谁已经问过）
//   history[]（**已经答过的问答**，刷新/回看用）
//
// 【为什么必须回 history】
// 2026-11-15 录制前实测：提交答案后前端 setAnswer('')、判分卡只显示分数与 gaps，
// 用户**再也看不到自己刚写的那段话**；而这条路由原来不带 turns，
// 刷新一下连"问过什么"都没了。回答稿是录制环节的一部分——评委问什么、
// 你怎么答、评委怎么判，必须是同一条可回看的时间线，否则"预演"这件事没有留存。

import {
  loadSession,
  loadPersonas,
  loadTurns,
  loadAnchor,
  progressOf,
  currentQuestion,
  type TurnRow,
} from '@/lib/session';
import { MODE_MATRIX } from '@/lib/state';
import { q } from '@/lib/db';
import type { GradedLocator } from '@/lib/grade';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const session = loadSession(id);
  if (!session) {
    return Response.json(
      { ok: false, code: 'E_NO_SESSION', message: '找不到这场会话。' },
      { status: 404 },
    );
  }

  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  const progress = progressOf(session);

  // 「谁问过」= turns 里出现过的主问对应的 persona
  const turns = loadTurns(session.id);
  const askedPersonaIds = [...new Set(turns.map((t) => t.personaId))];

  // 当前该说话的人：优先用状态机算出来的结果；会话已结束则为 null
  const cur = currentQuestion(session);
  const currentPersonaId = cur ? cur.persona.id : null;

  // 已问过 = 出现在 turns 里、且不是当前这位（当前者要显示下划线，不降透明度）
  const pastPersonaIds = askedPersonaIds.filter((pid) => pid !== currentPersonaId);

  const docName = String(q.get(`select name from documents where id = ?`, session.docId)?.name ?? '材料');

  // dimension 是排席位时存下的真值，直接用它，不做"按 color 反查"或"按首问 claim 猜"。
  // 旧数据若该列为 NULL，回落到 logic（并把 null 暴露出去，便于排查）。
  const personasOut = personas.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    focus: p.focus,
    tone: p.tone,
    color: p.color,
    dimension: p.dimension ?? 'logic',
    dimensionMissing: p.dimension === null,
  }));

  const personaById = new Map(personas.map((p) => [p.id, p]));

  return Response.json({
    ok: true,
    sessionId: session.id,
    docName,
    state: session.state,
    mode: session.mode,
    modeLabel: matrix.label,
    personas: personasOut,
    progress,
    currentPersonaId,
    pastPersonaIds,
    history: turns.map((t) => toHistoryItem(t, personaById)),
  });
}

/**
 * 把一条 turn 转成前端回看用的问答记录。
 *
 * 【为什么 gaps / locators 要在这里解析】
 * 它们在库里是 JSON 字符串（评分时原样存下来的）。若把字符串直接给前端，
 * 前端就得自己 JSON.parse 一遍——那是"把库的存储格式泄漏到展示层"，
 * 下次换存储格式前端就得跟着改。解析放在服务端，前端只拿结构化数据。
 */
function toHistoryItem(t: TurnRow, personaById: Map<string, { id: string; name: string; dimension: string | null; color: string }>) {
  const p = personaById.get(t.personaId);
  const anchor = t.targetClaimId ? loadAnchor(t.targetClaimId) : null;
  return {
    turnId: t.id,
    seq: t.seq,
    round: t.round,
    kind: t.kind === 'followup' ? ('followup' as const) : ('question' as const),
    personaId: t.personaId,
    personaName: p?.name ?? null,
    personaDimension: p?.dimension ?? null,
    question: t.question,
    answer: t.answer,
    score: t.score,
    gaps: parseJsonArray<string>(t.gaps),
    locators: parseJsonArray<GradedLocator>(t.locators),
    verifiedOk: t.verifiedOk,
    /** 这一问的锚点（没有 target_claim_id 的旧数据为 null） */
    anchor: anchor
      ? {
          claimId: anchor.claimId,
          blockIdx: anchor.blockIdx,
          page: anchor.page,
          section: anchor.section,
          quote: anchor.quote,
          locatorKind: anchor.locatorKind,
          verified: anchor.verified,
        }
      : null,
    createdAt: t.createdAt,
  };
}

/** 宽容解析："不是合法 JSON 就当空数组"，绝不让一条坏数据把整页打挂 */
function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
