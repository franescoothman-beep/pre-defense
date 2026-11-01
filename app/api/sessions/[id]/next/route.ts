// app/api/sessions/[id]/next/route.ts —— 换评委 / 下一问 / 结束（阶段 4 第 4 条）
//
// 【为什么要单独一条路由，而不是让 SSE 自己算下一个】
// SSE 的 GET 语义是"把当前这一问吐出来"，它不该推进会话。若 GET 自己推进状态，
// 刷新页面就会凭空多问一轮——浏览器预取、重连、反向代理重试都会触发它。
// 所以推进必须是 POST。这条路由就是那个显式的"按钮"。
//
// 【它做什么】
//   - 检查会话没结束
//   - 算该轮到谁、还剩几问
//   - 若主问配额已用尽 → 直接把会话置 ENDED，告诉前端去出报告
//   - 否则返回"下一位该问谁"，具体问题交给 SSE 流式生成（流式卖点不能绕过这条路径）
//
// 【幂等性】重复调用必须安全。判定完全由 turns 表里的已有数据决定，
// 不写任何"进度指针"——指针是能在崩溃后失步的，而 turns 表是事实。

import { q } from '@/lib/db';
import { loadSession, loadPersonas, loadTurns, judgeCountOf } from '@/lib/session';
import { MODE_MATRIX, judgesOf, mainsDoneOf, mainsNeededOf, personaIndexOfMain } from '@/lib/state';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await ctx.params;

  const session = loadSession(sessionId);
  if (!session) {
    return Response.json({ ok: false, code: 'E_NO_SESSION', message: '找不到这场会话。' }, { status: 404 });
  }

  // 已结束就不要再推进（但要如实告诉前端"该出报告了"，而不是报错）
  if (session.state === 'ENDED' || session.state === 'REPORTED') {
    return Response.json({
      ok: true,
      state: session.state,
      nextAction: 'report',
      message: '本场已结束，可以出报告。',
    });
  }

  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  if (personas.length === 0) {
    return Response.json(
      { ok: false, code: 'E_NO_PERSONA', message: '这场会话没有评委，请重新创建。' },
      { status: 409 },
    );
  }

  const judgesActual = Math.min(personas.length, judgesOf({ mode: session.mode }));
  const turns = loadTurns(session.id);

  // 还有一条"问出来但没人答"的 turn → 不该推进，让前端接着答那一问
  const pending = turns.find(
    (t) => (t.answer === null || t.answer === '') && t.question !== null && t.question !== '',
  );
  if (pending) {
    const p = personas.find((x) => x.id === pending.personaId) ?? personas[0];
    return Response.json({
      ok: true,
      state: session.state,
      nextAction: 'answer',
      message: '还有一问没有作答，先答完再继续。',
      pendingTurnId: pending.id,
      persona: { id: p.id, name: p.name, dimension: p.dimension, role: p.role },
    });
  }

  const mains = mainsDoneOf(turns);
  const needed = mainsNeededOf({ mode: session.mode, judges: judgesActual });

  // 主问配额用尽 → 收口（报告永不缺席）
  if (mains >= needed) {
    const now = new Date().toISOString();
    q.run(`update sessions set state = 'ENDED', ended_at = ? where id = ?`, now, session.id);
    return Response.json({
      ok: true,
      state: 'ENDED',
      nextAction: 'report',
      message: `主问已问完（${mains}/${needed}），可以出报告。`,
      progress: {
        mains,
        qTotal: Math.min(matrix.maxTurns, needed),
        personaCount: judgesActual,
      },
    });
  }

  // 否则：告诉前端"下一位是谁"，问题本身由 SSE 流式生成
  const seat = personaIndexOfMain(mains, matrix.mainsEach, judgesActual);
  const next = personas[seat] ?? personas[0];

  // 会话进入 ASKING（有 turn 在等回答）。第一次推进时由 PERSONAS_READY → ASKING。
  q.run(`update sessions set state = 'ASKING' where id = ?`, session.id);

  return Response.json({
    ok: true,
    state: 'ASKING',
    nextAction: 'stream',
    persona: {
      id: next.id,
      name: next.name,
      role: next.role,
      focus: next.focus,
      tone: next.tone,
      color: next.color,
      dimension: next.dimension ?? 'logic',
      seat: seat + 1,
      seatTotal: judgesActual,
    },
    progress: {
      mains,
      qIndex: mains + 1,
      qTotal: Math.min(matrix.maxTurns, needed),
      personaCount: judgesActual,
      judgeCountOf: judgeCountOf(session),
    },
  });
}
