// app/api/reports/[id]/route.ts —— 读取一份报告（§3.6 GET /api/reports/:id）
//
// 【只读】报告落库之后就是不可变的证据。若让 GET 顺手补算点什么，
// 同一份报告刷新两次可能给出不同的数字——那就不是"可复现"了。
// 所以这里只做"读出来 + 反序列化 + 结构兜底"，一个字符都不改。
//
// 同时返回足够的上下文让报告页不必再打三个接口：
//   - 材料名、档位、本场主问进度（报告页的封皮带要显示）
//   - 会话的 turns 摘要（「审议轨迹」要按评委顺序列出问与答）
//   - claims 的锚点（报告里每一条风险都要能点回原文那一句）

import { q } from '@/lib/db';
import { reportPayloadOf, DIMENSION_LABEL } from '@/lib/report';
import { loadSession, loadPersonas, loadTurns, loadClaimsOfDoc } from '@/lib/session';
import { MODE_MATRIX, mainsDoneOf, mainsNeededOf } from '@/lib/state';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: reportId } = await ctx.params;

  const row = q.get(`select * from reports where session_id = ?`, reportId);
  if (!row) {
    return Response.json(
      { ok: false, code: 'E_NO_REPORT', message: '这份报告还不存在。请先点「结束并出报告」。' },
      { status: 404 },
    );
  }

  const session = loadSession(reportId);
  if (!session) {
    // 报告在但会话没了：说明库被手工改过。仍然把报告原样给出（报告本身是完整证据），
    // 只是没有上下文可附。这比 404 好：用户手上的链接不该因为内部不一致就打不开。
    return Response.json({ ok: true, reportId, context: null, ...reportPayloadOf(row, reportId) });
  }

  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  const turns = loadTurns(session.id);
  const claims = loadClaimsOfDoc(session.docId);
  const claimById = new Map(claims.map((c) => [c.id, c]));

  // 审议轨迹：按评委顺序列出「谁问了什么、我怎么答的、给了几分」
  const trajectory = turns
    .filter((t) => t.question !== '')
    .map((t) => {
      const p = personas.find((x) => x.id === t.personaId);
      const c = t.targetClaimId ? claimById.get(t.targetClaimId) : null;
      return {
        turnId: t.id,
        seq: t.seq,
        round: t.round,
        kind: t.kind,
        personaId: t.personaId,
        personaName: p?.name ?? '评委',
        dimension: p?.dimension ?? null,
        question: t.question,
        answer: t.answer,
        score: t.score,
        gaps: t.gaps ? safeJson(t.gaps, []) : [],
        verifiedOk: t.verifiedOk,
        claimId: t.targetClaimId,
        blockIdx: c?.blockIdx ?? null,
        page: c?.page ?? null,
        section: c?.section ?? null,
        quote: c?.quote ?? '',
        locatorKind: c?.locatorKind ?? null,
      };
    });

  const docName = String(q.get(`select name from documents where id = ?`, session.docId)?.name ?? '材料');

  return Response.json({
    ok: true,
    reportId,
    context: {
      sessionId: session.id,
      docId: session.docId,
      docName,
      mode: session.mode,
      modeLabel: matrix.label,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      judgeCount: personas.length,
      mains: mainsDoneOf(turns),
      mainsPlanned: mainsNeededOf({ mode: session.mode, judges: Math.min(personas.length || matrix.judges, matrix.judges) }),
      dimensionLabel: DIMENSION_LABEL,
      // 覆盖缺口必须显式给出：quick 档只问 3 问，必然覆盖不满 4 维，
      // 报告页要写"本场 3 问，覆盖 3/4 维 · 完整评审请切 full 档"，而不是假装都覆盖了。
      personas: personas.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        dimension: p.dimension ?? 'logic',
        color: p.color,
      })),
      trajectory,
    },
    ...reportPayloadOf(row, reportId),
  });
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
