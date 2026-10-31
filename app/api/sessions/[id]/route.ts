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

import { loadSession, loadPersonas, loadTurns, progressOf, currentQuestion } from '@/lib/session';
import { MODE_MATRIX } from '@/lib/state';
import { q } from '@/lib/db';

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
  });
}
