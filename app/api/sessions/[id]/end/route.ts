// app/api/sessions/[id]/end/route.ts —— 结束并出报告（C11 的出口）
//
// 【C11 原文】"任何状态可调，立刻出报告"。
// 这句话在产品上意味着：用户在任何时刻点「结束并出报告」，都必须真的拿到一份报告。
// 它在工程上意味着三件必须做到的事：
//   1. **不依赖前置条件**。还没作答、作答到一半、模型挂了、预算烧光——全都能出。
//   2. **幂等**。重复点两次不产生两份报告、不重复烧预算。
//   3. **没有模型也能出**。模型失败时退回"聚合 + 模板"版报告，字段结构完全一样，
//      只是 comment 换成服务端算出来的事实句。一份字段齐全、数字正确、但文笔朴素的报告，
//      远胜于一个"报告生成失败"的空白页。
//
// 【为什么报告分要在这里也算一遍】
// risk_score 由 claims 聚合（lib/report.ts），**不依赖本场问了几轮**。
// 所以"问 1 轮就结束"和"问 3 轮结束"算出来的材料风险是同一个数——这正是可复现的落点。
// performance.score 才依赖本场作答，没作答就是"未覆盖"（null），不填 0、不填均值。

import { q, tx } from '@/lib/db';
import { callLLM, LlmError } from '@/lib/llm';
import { loadSession, loadPersonas, loadTurns, loadClaimsOfDoc, loadBlocksOfDoc, loadAnchor } from '@/lib/session';
import { REPORT_SYSTEM, buildReportUser, ReportSchema } from '@/lib/prompts/report.v1';
import { attachReportLocator } from '@/lib/locator';
import {
  aggregateMaterialRisk,
  normalizePerformance,
  coverageOf,
  highRiskOf,
  reportPayloadOf,
  deltaFor,
  DIMENSIONS,
  DIMENSION_LABEL,
  type ClaimBrief,
  type ClaimRow,
  type Dimension,
} from '@/lib/report';
import { MODE_MATRIX, judgesOf, mainsDoneOf, mainsNeededOf } from '@/lib/state';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await ctx.params;

  const session = loadSession(sessionId);
  if (!session) {
    return Response.json({ ok: false, code: 'E_NO_SESSION', message: '找不到这场会话。' }, { status: 404 });
  }

  // ---------- 幂等：已有报告就直接返回 ----------
  // 【为什么必须先查】前端"结束"按钮可能被点两次（手抖/网络重试），
  // 而报告生成要调一次模型（30s 超时、1 次预算）。重复生成既慢又浪费预算，
  // 还会因为两次模型输出不同而产生"同一场两份互相矛盾的报告"。
  const existing = q.get(`select * from reports where session_id = ?`, sessionId);
  if (existing) {
    if (session.state !== 'REPORTED') {
      q.run(`update sessions set state = 'REPORTED' where id = ?`, session.id);
    }
    return Response.json({
      ok: true,
      reportId: sessionId,
      cached: true,
      ...reportPayloadOf(existing, sessionId),
    });
  }

  // ---------- 聚合：材料风险（纯服务端，不依赖模型） ----------
  const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
  const personas = loadPersonas(session.id, session.docId, matrix.judges);
  const judgesActual = Math.max(1, Math.min(personas.length || judgesOf({ mode: session.mode }), judgesOf({ mode: session.mode })));
  const turns = loadTurns(session.id);
  const claims = loadClaimsOfDoc(session.docId);
  const blocks = loadBlocksOfDoc(session.docId);

  const claimRows: ClaimRow[] = claims.map((c) => ({
    id: c.id,
    dimension: c.dimension as Dimension,
    risk: c.risk,
    verified: c.verified,
    locator_kind: c.locatorKind,
  }));
  const riskCells = aggregateMaterialRisk(claimRows);

  // 本场真正被问到的维度。
  //
  // 【2026-11-01 修正：口径从"claim 的维度"改成"评委的维度"】
  // 旧实现：askedDims = 被问到的 claim 各自的 dimension。
  // 实测发现这会造成**报告自相矛盾**：陈评委（席位维度 depth）在问，但其候选 claim
  // 的 dimension 可能是 evidence（planSeats 允许同维度下的类型补位，也允许候选池里挑到别的维度）。
  // 结果：报告里 depth 维的 risk_score 有值（58），却标着"本场未覆盖技术深度维度"、
  //   performance 里 depth 也是 null —— 而用户明明被问过 depth 的问题。
  //
  // 正确口径：评委盯哪个维度，他问的那一轮就覆盖了哪个维度。
  // 这才是"本场覆盖了哪几维"的语义——用户感知的就是"我被几个不同视角的评委问过"。
  // claim 的维度用于材料风险聚合（材料本身按维度分），两者是不同的东西，不该混用同一个集合。
  const askedClaimIds = new Set(
    turns.flatMap((t) => (t.targetClaimId ? [t.targetClaimId] : [])),
  );
  const askedDims = new Set<Dimension>();
  for (const t of turns) {
    // 只算真的问出来的（question 非空的 turn）；空占位不算覆盖
    if (t.question === '') continue;
    const p = personas.find((x) => x.id === t.personaId);
    if (p?.dimension) askedDims.add(p.dimension as Dimension);
  }

  // ---------- 调模型写评语 ----------
  const sources = new Map<number, string>();
  for (const c of claims) {
    const b = blocks.find((x) => x.idx === c.blockIdx);
    if (b) sources.set(c.blockIdx, b.text);
  }

  const turnsForModel = turns
    .filter((t) => t.question !== '' && (t.answer !== null || t.kind === 'question'))
    .map((t) => ({
      personaName: personas.find((p) => p.id === t.personaId)?.name ?? '评委',
      question: t.question,
      answer: t.answer,
      score: t.score,
      gaps: t.gaps,
      kind: t.kind,
    }));

  type ReportModelOut = {
    material_risk: Array<{ dimension: Dimension; comment: string; locators: Array<{ kind?: 'quote' | 'absence'; block_idx: number; quote?: string; scope?: string }> }>;
    performance: Array<{ dimension: Dimension; score: number; comment?: string }>;
    high_risk: Array<{ claim_id: string; question: string; why: string; suggestion: string }>;
    advice: string;
  };

  let modelOut: ReportModelOut | null = null;

  try {
    const out = await callLLM({
      sessionKey: session.id,
      phase: 'report',
      system: REPORT_SYSTEM,
      user: buildReportUser({
        docName: String(q.get(`select name from documents where id = ?`, session.docId)?.name ?? '材料'),
        mode: session.mode,
        modeLabel: matrix.label,
        coveredDimensions: DIMENSIONS.filter((d) => askedDims.has(d)).map((d) => DIMENSION_LABEL[d]),
        riskByDimension: riskCells.map((r) => ({ dimension: r.dimension, riskScore: r.risk_score, claims: r.claims })),
        claims: claims.map((c) => ({
          id: c.id,
          text: c.text,
          dimension: c.dimension,
          risk: c.risk,
          type: c.type,
          quote: c.quote,
          locatorKind: c.locatorKind,
          section: c.section,
          page: c.page,
          askedInSession: askedClaimIds.has(c.id),
        })),
        turns: turnsForModel,
        sources: [...sources.entries()].map(([blockIdx, text]) => ({ blockIdx, text })),
        qTotal: mainsNeededOf({ mode: session.mode, judges: judgesActual }),
      }),
      schema: ReportSchema,
      temperature: 0.3,
    });
    modelOut = out.data as ReportModelOut;
  } catch (e) {
    const err = e as LlmError;
    // 【关键降级】报告不能因为模型挂了就缺位。这里必须留日志，然后走模板。
    console.error('[POST /end] 报告模型调用失败，退回聚合+模板：', err.code, err.message);
  }

  // ---------- 落库 ----------
  // 材料风险：模型只贡献 comment 与 locators，risk_score **一律取服务端聚合值**
  const materialRisk = DIMENSIONS.map((dimension) => {
    const cell = riskCells.find((r) => r.dimension === dimension)!;
    const fromModel = modelOut?.material_risk?.find((m) => m.dimension === dimension);

    /**
     * 【两栏的 "covered" 语义不同，这是 C14 的另一面】
     *
     * 左栏（材料风险）的 covered = 「**材料**在这一维上有没有质疑点」，即 risk_score 有没有值。
     *   它与"本场问了几轮"无关：一份材料的逻辑链风险是材料自身的属性，
     *   就算这一维没被问到，它该显示 75 就显示 75。
     *
     * 右栏（临场表现）的 covered = 「**本场**有没有在这一维上问过」，即有没有作答可评。
     *   没被问过就没有可评的表现，必须显示"未覆盖"，不许填 0。
     *
     * 【为什么之前会自相矛盾】旧实现两栏都用同一个 askedDims 集合，
     * 于是出现"risk_score=58 但标未覆盖、评语说本场未覆盖技术深度"的荒唐结果——
     * 风险分是服务端算出来的真实数字，旁边却写"你没覆盖这一维"。
     * 两个概念用同一个变量，是这类矛盾最常见的来源。
     */
    const hasMaterialForDim = cell.risk_score !== null;
    // 模型可能给一个材料里根本没有的维度（"编"），这里按"材料有没有这一维"拦掉
    const hasModelComment = Boolean(fromModel?.comment);

    const locators = fromModel?.locators?.length
      ? gradeReportLocators(blocks, fromModel.locators)
      : [];

    const comment = hasMaterialForDim && hasModelComment
      ? fromModel!.comment
      : templateComment(dimension, cell.risk_score, cell.claims, cell.absence, hasMaterialForDim);

    return {
      dimension,
      label: DIMENSION_LABEL[dimension],
      risk_score: cell.risk_score, // 服务端聚合，模型无权改
      claims: cell.claims,
      absence: cell.absence,
      covered: hasMaterialForDim,
      /** 本场有没有在这一维上真的问过（与右栏同一口径，供看板与"覆盖缺口"使用） */
      askedInSession: askedDims.has(dimension),
      comment,
      locators,
    };
  });

  // 临场表现：只有这项由模型给分；没被问到的维度 → null（不填 0、不填均值）
  const perfRaw = (modelOut?.performance ?? []).filter((p) => askedDims.has(p.dimension));
  const performance = normalizePerformance(
    perfRaw.filter((p) => p.score !== null && p.score !== undefined),
  ).map((p) => ({
    ...p,
    // 不是本场覆盖到的维度 → 显式置 null，让 UI 显示"未覆盖"而不是 0 分
    score: askedDims.has(p.dimension) ? p.score : null,
    label: DIMENSION_LABEL[p.dimension],
    covered: askedDims.has(p.dimension),
  }));

  // 高风险清单：模型的 claim_id 必须真实存在，不存在的丢弃（防编造锚点）
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const highRiskFromModel = (modelOut?.high_risk ?? [])
    .filter((h) => claimById.has(h.claim_id))
    .slice(0, 8)
    .map((h) => {
      const c = claimById.get(h.claim_id)!;
      return {
        claimId: c.id,
        dimension: c.dimension,
        risk: c.risk,
        actionable: c.locatorKind === 'absence',
        question: h.question,
        why: h.why,
        suggestion: h.suggestion,
        quote: c.quote,
        section: c.section,
        page: c.page,
        blockIdx: c.blockIdx,
        text: c.text,
      };
    });

  // 模型没给可用清单时，退回"按 risk 排序的真实 claim"——
  // 一条 suggestion 都没有的高风险清单仍然比空清单有用：用户至少能点回原文。
  const highRisk = highRiskFromModel.length > 0
    ? highRiskFromModel
    : highRiskOf(
        claims.map((c) => ({
          id: c.id,
          dimension: c.dimension as Dimension,
          risk: c.risk,
          verified: c.verified,
          locator_kind: c.locatorKind,
          text: c.text,
          quote: c.quote,
          section: c.section,
          page: c.page,
          block_idx: c.blockIdx,
        })),
        8,
      ).map((h) => ({
        ...h,
        question: '',
        why: '',
        suggestion: '',
      }));

  // ---------- 二练对比（只有 drill / revise 才有"上一场"可比） ----------
  //
  // 【为什么必须在出报告时算完落库，而不是读接口现算】
  // 报告是证据。读接口现算等于"每次打开都重新解释一遍"，而 claims 可能后来被重抽过
  // （doc 页有「重新抽取」按钮），那时历史报告的对比数字会跟着变——
  // 同一份报告两个时间打开给出不同结论，就不是可复现，而是不可信。
  const prevReport = session.drillFrom
    ? q.get(`select * from reports where session_id = ?`, session.drillFrom)
    : null;
  let delta = null as ReturnType<typeof deltaFor>;
  if (prevReport && session.drillFrom) {
    const prevSession = loadSession(session.drillFrom);
    const prevClaims = prevSession ? loadClaimsOfDoc(prevSession.docId) : [];
    const briefOf = (c: { id: string; type: string; dimension: string; risk: number; text: string; quote: string; locatorKind: string }): ClaimBrief => ({
      id: c.id,
      type: c.type,
      dimension: c.dimension,
      risk: c.risk,
      text: c.text,
      quote: c.quote,
      locator_kind: c.locatorKind,
    });
    delta = deltaFor({
      kind: session.mode === 'drill' ? 'drill' : 'revise',
      prevReport,
      nowRisk: riskCells,
      nowPerf: performance.map((p) => ({ dimension: p.dimension, score: p.score })),
      prevClaims: prevClaims.map(briefOf),
      nowClaims: claims.map(briefOf),
    });
    if (!delta) {
      // 上一场报告存在但解析不出来：如实放弃对比，而不是编一个全 0 的表格
      console.warn('[POST /end] 上一场报告无法解析，二练对比跳过：', session.drillFrom);
    }
  }

  const coverage = coverageOf(
    riskCells,
    performance.map((p) => ({ dimension: p.dimension, score: p.score })),
  );

  const advice = modelOut?.advice?.trim() ||
    `本场共问 ${mainsDoneOf(turns)}/${mainsNeededOf({ mode: session.mode, judges: judgesActual })} 个主问。` +
      `材料风险分最高的维度是 ${
        [...riskCells].filter((r) => r.risk_score !== null).sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0))[0]?.dimension
          ? DIMENSION_LABEL[
              [...riskCells].filter((r) => r.risk_score !== null).sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0))[0].dimension
            ]
          : '（本场无覆盖）'
      }，建议先补这一维的短板，再开下一场。`;

  const now = new Date().toISOString();
  const reportRow = {
    material_risk: JSON.stringify(materialRisk),
    performance: JSON.stringify(performance),
    coverage: JSON.stringify({
      risk: coverage.risk,
      perf: coverage.perf,
      note: coverage.note,
      askedDimensions: [...askedDims],
      absentDimensions: DIMENSIONS.filter((d) => !askedDims.has(d)),
    }),
    high_risk: JSON.stringify(highRisk),
    advice,
  };

  tx(() => {
    q.run(
      `insert into reports(session_id, material_risk, performance, coverage, high_risk, advice, prev_session_id, delta, created_at)
       values(?,?,?,?,?,?,?,?,?)`,
      session.id,
      reportRow.material_risk,
      reportRow.performance,
      reportRow.coverage,
      reportRow.high_risk,
      reportRow.advice,
      session.drillFrom,
      delta === null ? null : JSON.stringify(delta),
      now,
    );
    q.run(`update sessions set state = 'REPORTED', ended_at = ? where id = ?`, now, session.id);
  });

  const saved = q.get(`select * from reports where session_id = ?`, session.id)!;
  return Response.json({
    ok: true,
    reportId: session.id,
    cached: false,
    degraded: modelOut === null,
    ...reportPayloadOf(saved, session.id),
  });
}

/**
 * 报告里的 locator 也过一遍机检：命中率的分母里要算上它（与判分同一口径）。
 *
 * 【为什么用 attachReportLocator 而不是 attachLocator】
 * 模型实测会把 locators 写成纯字符串数组（只有 quote、没有 block_idx）。
 * attachLocator 对这种情况会判越界并丢弃整条——引用就静默消失了。
 * attachReportLocator 保留 quote、标"位置未标注"、verified=0，
 * 让用户仍能看到模型指着哪一句话在说，同时它会被算进分母（不是"验证通过"）。
 */
function gradeReportLocators(
  blocks: ReturnType<typeof loadBlocksOfDoc>,
  raws: Array<{ kind?: 'quote' | 'absence'; block_idx: number; quote?: string; scope?: string }>,
) {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of raws) {
    const { locator, verified, reason } = attachReportLocator(blocks, {
      kind: raw.kind === 'absence' ? 'absence' : 'quote',
      block_idx: raw.block_idx,
      quote: raw.quote,
      scope: raw.scope,
    });
    if (!locator) continue;
    out.push({
      blockIdx: locator.blockIdx,
      page: locator.page,
      section: locator.section,
      quote: locator.quote,
      kind: locator.kind,
      scope: locator.scope,
      verified,
      reason,
    });
  }
  return out;
}

/**
 * 模型没给评语时的模板句：只陈述聚合出的事实，不编判断。
 *
 * `hasMaterial` 语义是「**材料**在这一维上有没有质疑点」——
 * 不是"本场有没有问到"。模板句必须与此一致，否则会写出
 * "本场未覆盖技术深度维度"却又在旁边显示 risk_score=58 的自相矛盾。
 */
function templateComment(
  dimension: Dimension,
  riskScore: number | null,
  claims: number,
  absence: number,
  hasMaterial: boolean,
): string {
  const label = DIMENSION_LABEL[dimension];
  if (!hasMaterial || riskScore === null) {
    return `这份材料里没有关于${label}维度的质疑点，因此这一维没有风险分（显示为未覆盖，而不是 0 分）。`;
  }
  const level = riskScore >= 70 ? '高' : riskScore >= 40 ? '中' : '低';
  return `${label}维度聚合风险 ${riskScore}（${level}），来自 ${claims} 条质疑点` +
    (absence > 0 ? `，其中 ${absence} 条是"该写没写"（补上即可消除）` : '') +
    '。这句是服务端按质疑点聚合出的事实描述，模型本次没有返回评语。';
}

// 注意：路由文件只许导出 Next 认得的东西（dynamic / maxDuration / HTTP 方法）。
// 曾在文件末尾写 `export { loadAnchor }`，build 期直接报
// "does not satisfy the constraint '{ [x: string]: never; }'"。tsc 与单测都查不出来。
