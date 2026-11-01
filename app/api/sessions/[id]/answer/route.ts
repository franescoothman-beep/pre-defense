// app/api/sessions/[id]/answer/route.ts —— 作答 → 判分 → 机检 → 收口（阶段 4 的主干）
//
// 【这个路由是整条链路的汇合点，所以顺序必须写死】
//   1. 校验入参：turnId 必须存在、必须属于本场、必须还没被答过（防重复提交 / 防串场）
//   2. 调 evaluate：拿 score / gaps / locators / followup
//   3. **机检** locators（lib/grade.ts）：quote 逐字 / absence 查 scope，写 verified_ok
//   4. 归属校验 followup：不在候选清单里的追问作废（宁可少问一次，不用假锚点）
//   5. 写回这一条 turn（answer / score / gaps / locators / verified_ok）
//   6. 用 lib/state.ts 的纯函数决定：追问 / 换人 / 结束
//   7. 追问则落一条新 turn（answer 空）并返回；换人则返回下一问的"该谁问"；结束则返回 end
//
// 【为什么第 6 步必须调纯函数，而不是在这里写 if】
// 收敛规则散进路由后，就再也无法单测了；而"追问什么时候停"正是 P0 级的风险
// （不死循环 = S6，也等于报告能不能准时出现 = C11）。
// 所以路由只做 IO，判断全在 lib/state.ts。
//
// 【关于 mock】本路由走 callLLM（非流式）。mock 时 phase='evaluate' 的录好的响应会被回放。
// 注意 evaluate 的 fixture 必须有：真实跑过一场之后的产物，不是手写。

import { q } from '@/lib/db';
import { callLLM, LlmError, budgetLeft } from '@/lib/llm';
import { loadSession, loadTurns, loadPersonas, loadClaimsOfDoc, loadAnchor, askedClaimIdsOf, loadBlocksOfDoc } from '@/lib/session';
import { EVALUATE_SYSTEM, buildEvaluateUser, EvaluateSchema, scoreToPercent } from '@/lib/prompts/evaluate.v1';
import { gradeLocators, verifiedOkOf, validateFollowup, roundOfSeq } from '@/lib/grade';
import { decide, MODE_MATRIX, judgesOf, mainsDoneOf, mainsNeededOf, FALLBACK_FOLLOWUP, type Turn } from '@/lib/state';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await ctx.params;

  let body: { turnId?: string; answer?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, code: 'E_FORM', message: '请求体必须是 JSON。' }, { status: 400 });
  }

  const session = loadSession(sessionId);
  if (!session) {
    return Response.json({ ok: false, code: 'E_NO_SESSION', message: '找不到这场会话。' }, { status: 404 });
  }
  if (session.state === 'ENDED' || session.state === 'REPORTED') {
    return Response.json(
      { ok: false, code: 'E_ENDED', message: '本场已结束，不能再作答。可以直接出报告。' },
      { status: 409 },
    );
  }

  const turnId = body.turnId?.trim();
  if (!turnId) {
    return Response.json({ ok: false, code: 'E_NO_TURN', message: '缺少 turnId。' }, { status: 400 });
  }

  const turnRow = q.get(
    `select id, session_id, persona_id, seq, round, kind, question, answer, target_claim_id
     from turns where id = ?`,
    turnId,
  );
  if (!turnRow) {
    return Response.json({ ok: false, code: 'E_NO_TURN', message: '找不到这一问。' }, { status: 404 });
  }
  // 【必须校验 turn 属于本场】不校验的话，拿 A 场的 turnId 打到 B 场就能改写别人的记录
  if (String(turnRow.session_id) !== sessionId) {
    return Response.json(
      { ok: false, code: 'E_TURN_MISMATCH', message: '这一问不属于本场会话。' },
      { status: 409 },
    );
  }
  // 已经答过的 turn 不许重复判分：重复提交会重复烧预算，且把旧答案覆盖掉
  const existingAnswer = turnRow.answer === null || turnRow.answer === undefined ? '' : String(turnRow.answer);
  if (existingAnswer.trim() !== '') {
    return Response.json(
      {
        ok: false,
        code: 'E_ALREADY_ANSWERED',
        message: '这一问已经提交过答案了。若想重新作答，请刷新页面从本场当前进度继续。',
      },
      { status: 409 },
    );
  }

  const answer = (body.answer ?? '').trim();
  // 空答案**不算错误**：真实答辩里"我不知道"也是回答的一种，它该拿低分而不是报错。
  // 但完全空白的提交（连空格都没）说明用户误点了，这时候给一条提醒比静默判 0 分更诚实。
  if (answer === '') {
    return Response.json(
      {
        ok: false,
        code: 'E_EMPTY_ANSWER',
        message: '回答是空的。哪怕只写一句"这一点我还没想清楚"，也比空白更能体现临场表现。',
      },
      { status: 400 },
    );
  }

  // ---------- 1) 取上下文：谁在问、问什么、依据在哪 ----------
  const personas = loadPersonas(session.id, session.docId);
  const persona = personas.find((p) => p.id === String(turnRow.persona_id)) ?? personas[0];
  if (!persona) {
    return Response.json(
      { ok: false, code: 'E_NO_PERSONA', message: '这场会话没有评委数据，请重新创建会话。' },
      { status: 409 },
    );
  }

  const targetClaimId = turnRow.target_claim_id === null || turnRow.target_claim_id === undefined
    ? null
    : String(turnRow.target_claim_id);
  const anchor = targetClaimId ? loadAnchor(targetClaimId) : null;
  const blocks = loadBlocksOfDoc(session.docId);

  const allClaims = loadClaimsOfDoc(session.docId);
  const currentClaim = targetClaimId ? allClaims.find((c) => c.id === targetClaimId) : null;

  // 追问候选池：本场还没 targeting 过的 claim，**外加本主问正在追的那条**。
  // 排除基准里要去掉本问自己（否则追问永远指向自己→被自己的去重打死）。
  const askedOthers = askedClaimIdsOf(session.id, turnId);
  const candidates = allClaims.filter(
    (c) => !askedOthers.includes(c.id) || c.id === targetClaimId,
  );

  const turnsBefore = loadTurns(session.id);
  const followupsSoFar = turnsBefore.filter(
    (t) => t.round === Number(turnRow.round) && t.kind === 'followup',
  ).length;

  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const judgesActual = Math.min(personas.length || judgesOf({ mode: session.mode }), judgesOf({ mode: session.mode }));

  // ---------- 2) 判分 ----------
  let out;
  try {
    out = await callLLM({
      sessionKey: session.id,
      phase: 'evaluate',
      system: EVALUATE_SYSTEM,
      user: buildEvaluateUser({
        persona: { name: persona.name, role: persona.role, focus: persona.focus, tone: persona.tone },
        question: String(turnRow.question),
        claim: currentClaim
          ? {
              id: currentClaim.id,
              text: currentClaim.text,
              type: currentClaim.type,
              risk: currentClaim.risk,
              quote: currentClaim.quote,
              locatorKind: currentClaim.locatorKind,
              section: currentClaim.section,
              page: currentClaim.page,
            }
          : null,
        source: anchor?.source ?? '',
        answer,
        candidates: candidates.slice(0, 6).map((c) => ({
          id: c.id,
          type: c.type,
          text: c.text,
          risk: c.risk,
          section: c.section,
          page: c.page,
          quote: c.quote,
          locatorKind: c.locatorKind,
        })),
        qIndex: Number(turnRow.round),
        qTotal: mainsNeededOf({ mode: session.mode, judges: judgesActual }),
        followupsSoFar,
      }),
      schema: EvaluateSchema,
      temperature: 0.2,
    });
  } catch (e) {
    const err = e as LlmError;
    // 【判分失败不能让整场挂掉】这是用户已经付出的作答，丢掉=白答一次。
    // 做法：把答案存下来、标"未判分"，然后让流程继续（走"无追问→下一问"）。
    // 前端据此显示"这次评委没能给出评价，但不影响你继续"。
    console.error('[POST /answer] 判分失败：', err.code, err.message);
    q.run(`update turns set answer = ? where id = ?`, answer, turnId);
    return Response.json({
      ok: true,
      degraded: true,
      code: err.code ?? 'E_LLM',
      message: '评委这次没能给出评价（模型调用失败），但你的回答已经保存。可以继续下一问。',
      evaluation: null,
      followup: null,
      state: 'ANSWERED',
      budgetLeft: budgetLeft(session.id),
      progress: progressPayload(session, personas, turnsBefore.concat([{ id: turnId, seq: Number(turnRow.seq), round: Number(turnRow.round), kind: String(turnRow.kind), personaId: persona.id, question: String(turnRow.question), answer, score: null, gaps: null, locators: null, verifiedOk: null, targetClaimId, createdAt: null }])),
    });
  }

  const data = out.data as {
    score: number;
    gaps: string[];
    locators: Array<{ kind?: 'quote' | 'absence'; block_idx: number; quote?: string; scope?: string }>;
    followup: { question: string; target_claim_id: string; resolved: boolean } | null;
  };

  // ---------- 3) 机检 ----------
  const graded = gradeLocators(blocks, data.locators);
  const verifiedOk = verifiedOkOf(graded);

  // ---------- 4) 追问归属校验 ----------
  const allowedIds = new Set(candidates.map((c) => c.id));
  const followup = validateFollowup(data.followup, { allowedIds, currentClaimId: targetClaimId });

  // ---------- 5) 写回这一问 ----------
  const turnPatch = {
    answer,
    score: data.score,
    gaps: JSON.stringify(data.gaps ?? []),
    locators: JSON.stringify(graded),
    verifiedOk,
  };
  q.run(
    `update turns set answer = ?, score = ?, gaps = ?, locators = ?, verified_ok = ? where id = ?`,
    turnPatch.answer, turnPatch.score, turnPatch.gaps, turnPatch.locators, turnPatch.verifiedOk, turnId,
  );

  // ---------- 6) 决定下一步（纯函数） ----------
  const turnsNow: Turn[] = loadTurns(session.id).map((t) => ({
    seq: t.seq,
    round: t.round,
    kind: (t.kind === 'followup' ? 'followup' : 'question'),
    personaId: t.personaId,
    targetClaimId: t.targetClaimId,
    question: t.question,
  }));

  // 判分完成即视为"这一问已被答过"，此时规则 7 的"主问已问完"才能真正收口：
  // mainsDone 数的是 kind='question' 的 turn（含本问），所以这里无需额外加一。
  const snap = {
    mode: session.mode,
    state: 'ANSWERED' as const,
    turns: turnsNow,
    askedClaimIds: askedOthers,
    callCount: 30 - budgetLeft(session.id),
    lastQuestionAt: Date.now(),
    startedAt: Date.parse(session.startedAt) || Date.now(),
    judges: judgesActual,
  };

  const verdict = decide(snap, followup ? { followup: { question: followup.question, target_claim_id: followup.targetClaimId, resolved: followup.resolved } } : null, Date.now());

  // ---------- 7) 动作 ----------
  // 结束：把会话置 ENDED，前端立刻去 /end 出报告（报告永不缺席，C11）
  if (verdict.decision === 'end') {
    q.run(`update sessions set state = 'ENDED', ended_at = ? where id = ?`, new Date().toISOString(), session.id);
    return Response.json({
      ok: true,
      evaluation: publicEvaluation(data.score, graded, verifiedOk, data.gaps),
      followup: null,
      decision: 'end',
      endReason: verdict.reason,
      state: 'ENDED',
      budgetLeft: budgetLeft(session.id),
      progress: progressPayload(session, personas, loadTurns(session.id)),
      reportReady: true,
    });
  }

  // 追问：落一条新 turn（answer 空），前端接着流式展示这个追问
  if (verdict.decision === 'followup' && followup) {
    const nextSeq = turnsNow.length + 1;
    const followupTurnId = crypto.randomUUID();
    const fRound = roundOfSeq(nextSeq, 'followup', mainsDoneOf(turnsNow), matrix.mainsEach, judgesActual);
    q.run(
      `insert into turns(id, session_id, persona_id, seq, round, kind, question, answer, target_claim_id, created_at)
       values(?,?,?,?,?,?,?,?,?,?)`,
      followupTurnId, session.id, persona.id, nextSeq, fRound, 'followup',
      followup.question, '', followup.targetClaimId, new Date().toISOString(),
    );
    const fAnchor = loadAnchor(followup.targetClaimId);
    return Response.json({
      ok: true,
      evaluation: publicEvaluation(data.score, graded, verifiedOk, data.gaps),
      followup: {
        turnId: followupTurnId,
        personaId: persona.id,
        personaName: persona.name,
        question: followup.question,
        claimId: followup.targetClaimId,
        blockIdx: fAnchor?.blockIdx ?? null,
        source: fAnchor?.source ?? '',
        page: fAnchor?.page ?? null,
        section: fAnchor?.section ?? null,
        locatorKind: fAnchor?.locatorKind ?? 'quote',
        verified: fAnchor?.verified ?? null,
      },
      decision: 'followup',
      endReason: verdict.reason,
      state: 'ASKING',
      budgetLeft: budgetLeft(session.id),
      progress: progressPayload(session, personas, loadTurns(session.id)),
      reportReady: false,
    });
  }

  // 换下一位 / 下一问：只回"该谁问"，问题本身由 SSE 流式出（保持流式卖点）
  const mainsNow = mainsDoneOf(turnsNow);
  const mainsNeeded = mainsNeededOf({ mode: session.mode, judges: judgesActual });
  const finished = mainsNow >= mainsNeeded;

  return Response.json({
    ok: true,
    evaluation: publicEvaluation(data.score, graded, verifiedOk, data.gaps),
    followup: null,
    decision: finished ? 'end' : 'ask',
    endReason: verdict.reason,
    state: finished ? 'ENDED' : 'ANSWERED',
    // 前端下一步动作：finished → 出报告；否则 → 重新开一条 SSE 拿下一个问题
    nextAction: finished ? 'report' : 'stream',
    budgetLeft: budgetLeft(session.id),
    progress: progressPayload(session, personas, loadTurns(session.id)),
    reportReady: finished,
  });
}

/** 对外暴露的评价（不回传 prompt 里那些内部字段，也不回传原始 locator 里的 reason） */
function publicEvaluation(
  score: number,
  graded: ReturnType<typeof gradeLocators>,
  verifiedOk: 0 | 1,
  gaps: string[],
) {
  return {
    score,
    scorePercent: scoreToPercent(score),
    gaps: gaps ?? [],
    verifiedOk,
    locators: graded.map((g) => ({
      blockIdx: g.blockIdx,
      page: g.page,
      section: g.section,
      quote: g.quote,
      kind: g.kind,
      scope: g.scope,
      verified: g.verified,
      reason: g.reason,
    })),
  };
}

/** 进度（与 lib/session.ts 的 progressOf 同口径，但避免再查一次库：直接用已加载的 turns） */
function progressPayload(
  session: { mode: string; id: string },
  personas: Array<{ id: string }>,
  turns: Array<{ kind: string; answer: string | null }>,
) {
  const matrix = MODE_MATRIX[session.mode as keyof typeof MODE_MATRIX] ?? MODE_MATRIX.quick;
  const judgeCount = Math.max(1, Math.min(personas.length || matrix.judges, matrix.judges));
  const mains = turns.filter((t) => t.kind === 'question').length;
  const answered = turns.filter((t) => t.answer !== null && t.answer !== '').length;
  const qTotal = Math.min(matrix.maxTurns, judgeCount * matrix.mainsEach);
  return {
    qIndex: Math.min(mains + 1, qTotal || 1),
    qTotal,
    mains,
    answered,
    personaCount: judgeCount,
  };
}

/**
 * 注意：本文件除了 Next 允许的 `dynamic` / `maxDuration` / HTTP 方法之外，
 * **不导出任何其它符号**。曾经在这里写 `export { FALLBACK_FOLLOWUP }`，
 * 结果是 `next build` 报 "Property 'FALLBACK_FOLLOWUP' is incompatible with index signature"：
 * 路由模块被 Next 当成「只许导出方法」的约定对象，多导一个常量就编译不过。
 * （`npm run test` 与 `tsc --noEmit` 都发现不了这一条——只有真正跑 build 才会暴露。）
 */
