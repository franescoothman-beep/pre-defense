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
import { reportPayloadOf, DIMENSION_LABEL, boardOf, overallOfCells, overallScoreOf } from '@/lib/report';
import { loadSession, loadPersonas, loadTurns, loadClaimsOfDoc } from '@/lib/session';
import { MODE_MATRIX, mainsDoneOf, mainsNeededOf } from '@/lib/state';
import { isMockMode } from '@/lib/demo';

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

  // 质询风险看板（3 评委 × 4 维）。
  //
  // 【为什么由读接口算，而不是落进报告里】
  // 看板回答的是"这份材料在哪一格上最危险"，它是**材料**的属性，不是这一场的产物；
  // 而"这一格本场问到了几条"是这场的事实。前者重算不变（与左栏同一套权重），
  // 后者跟着 turns 走——两者都是只读推导，没有写库的必要，也就不存在"两份看板打架"。
  //
  // 【attribution：按 turn.personaId 归因】
  // 指令包原文要求看板给出"该评委提出的 claim 数"。
  // claim 的归属（type/dimension）是材料的属性，**谁问的**记在 turn 上——
  // 两者是不同的东西：depth 席位的评委可能追问一条 evidence 维的 claim，
  // 按 claim 归属计数会把归因整列丢掉（问出来的永远是席位数本身）。
  const askedClaimIds = new Set(
    turns.filter((t) => t.question !== '' && t.targetClaimId).map((t) => t.targetClaimId as string),
  );
  const attribution = {
    byClaim: new Map(
      turns
        .filter((t) => t.question !== '' && t.targetClaimId)
        .map((t) => [t.targetClaimId as string, t.personaId]),
    ),
  };
  const board = boardOf(
    claims.map((c) => ({
      id: c.id,
      dimension: c.dimension as never,
      risk: c.risk,
      verified: c.verified,
      locator_kind: c.locatorKind,
      type: c.type,
      text: c.text,
      quote: c.quote,
    })),
    personas.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    askedClaimIds,
    attribution,
  );

  const docName = String(q.get(`select name from documents where id = ?`, session.docId)?.name ?? '材料');

  const payload = reportPayloadOf(row, reportId);

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
      /** 复练：本场是从哪一场复练出来的（null = 这是首场） */
      drillFrom: session.drillFrom,
      /** 质询风险看板：3 行（质疑类型）× 4 列（维度） */
      board,
      /**
       * 两个总览大数字。
       * 都从**已落库的报告格子**推导（不是重新读 claims），保证报告不可变：
       * 读者拿页面上的四个格子就能验算 overallRisk。
       */
      overallRisk: overallOfCells(payload.material_risk as never),
      overallPerf: overallScoreOf(payload.performance as never),
      /**
       * MOCK 角标事实。
       * 【为什么由服务端给】模式是服务端事实，客户端读不到；
       * 报告页是 client component，不能直接渲染服务端的 MockBadge（footer 形态），
       * 所以把事实随数据一起带出来，页脚照实写一句。
       * 【为什么走 getMode()】运行期可被 /api/mode 切换，不能再用启动期 env 字面量，
       * 否则切到真实模式后报告页脚注还会谎称"录制回放"。
       */
      mock: isMockMode(),
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
    ...payload,
  });
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
