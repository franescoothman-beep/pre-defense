// lib/report.ts —— 报告聚合（纯函数）
// C13：material risk_score 由 claims 聚合，模型不出分
// C14：risk_score 越大越糟 / performance.score 越大越好，两者不共名、不共颜色
// C17：risk 分差只在换材料（revise）时存在；drill 只比 performance
import type { Block } from './parse';

export type Dimension = 'logic' | 'evidence' | 'depth' | 'expression';
export const DIMENSIONS: Dimension[] = ['logic', 'evidence', 'depth', 'expression'];
export const DIMENSION_LABEL: Record<Dimension, string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};

export type ClaimRow = {
  id: string;
  dimension: Dimension | string;
  risk: number; // 1-5
  verified: number | null; // 1 | 0 | null(absence)
  locator_kind: string; // 'quote' | 'absence'
};

export type RiskCell = {
  dimension: Dimension;
  risk_score: number | null; // 0-100，越大越危险；null = 该维未覆盖
  claims: number;
  absence: number;
};

/**
 * 权重：逐字命中的质疑最可信（1.0）；absence 是关于"该写没写"的判断，稍低（0.8）；
 * 未校验的引用说明模型可能看错了原文（0.5）。
 */
function weightOf(c: ClaimRow): number {
  if (c.locator_kind === 'absence') return 0.8;
  if (c.verified === 1) return 1.0;
  return 0.5;
}

export function aggregateMaterialRisk(claims: ClaimRow[]): RiskCell[] {
  return DIMENSIONS.map((dimension) => {
    const rows = claims.filter((c) => c.dimension === dimension);
    if (rows.length === 0) {
      return { dimension, risk_score: null, claims: 0, absence: 0 };
    }
    let num = 0, den = 0;
    for (const c of rows) {
      const w = weightOf(c);
      num += w * ((c.risk - 1) / 4);
      den += w;
    }
    return {
      dimension,
      risk_score: den > 0 ? Math.round((100 * num) / den) : null,
      claims: rows.length,
      absence: rows.filter((c) => c.locator_kind === 'absence').length,
    };
  });
}

export type PerformanceCell = { dimension: Dimension; score: number; comment?: string };

/**
 * 全场材料风险：把报告里四个格子按各自质疑点条数加权成一个 0–100 的数。
 *
 * 【为什么从格子算，而不是重新读 claims】
 * 报告是证据。claims 表可以被「重新抽取」按钮整批换掉，那时再拿新 claims 去算，
 * 一份历史报告的大数字会跟着变——同一份报告两次打开给出两个结论，就不可信了。
 * 从**已落库的格子**加权，好处是读者能拿页面上的四个数字当场验算：
 *   overall = round(Σ(score_i × claims_i) / Σclaims_i)，只统计有质疑点的维度。
 *
 * 四维格子本身是 claims 的纯函数（aggregateMaterialRisk），所以
 * 「risk_score 可由 claims 复算」仍然成立，且有单测钉住。
 *
 * 【没有质疑点 → null，不是 0】0 分意味"满分级安全"，那是造假。
 */
export function overallOfCells(cells: RiskCell[]): number | null {
  let num = 0;
  let den = 0;
  for (const c of cells) {
    if (c.risk_score === null || c.claims <= 0) continue;
    num += c.risk_score * c.claims;
    den += c.claims;
  }
  return den > 0 ? Math.round(num / den) : null;
}

/** 全场临场表现：本场真实问到的维度取平均；一个维度都没问到 → null */
export function overallScoreOf(rows: Array<{ score: number | null }>): number | null {
  const hit = rows.filter((r): r is { score: number } => typeof r.score === 'number');
  if (hit.length === 0) return null;
  return Math.round(hit.reduce((s, r) => s + r.score, 0) / hit.length);
}


/** 临场表现：模型给分，这里只做口径统一（缺维 → null，不补均值） */
export function normalizePerformance(rows: Array<{ dimension: string; score: number; comment?: string }>): Array<{ dimension: Dimension; score: number | null; comment: string }> {
  return DIMENSIONS.map((d) => {
    const hit = rows.find((r) => r.dimension === d);
    return { dimension: d, score: hit ? Math.max(0, Math.min(100, Math.round(hit.score))) : null, comment: hit?.comment ?? '' };
  });
}

export type DeltaKind = 'drill' | 'revise';

export type Delta = {
  /** 这条对比是哪种复练产生的 —— 决定 UI 说「风险降了」还是「表现升了」 */
  kind: DeltaKind;
  risk: Array<{ dimension: Dimension; prev: number; now: number; dir: -1 | 0 | 1; source: 'doc_diff' }>;
  perf: Array<{ dimension: Dimension; prev: number; now: number; dir: -1 | 0 | 1; source: 'answer_diff' }>;
  /** 只有 revise 才有：两次材料之间质疑点的增删（换了材料才谈得上"改好了没有"） */
  claims?: ClaimDiff;
};

/**
 * 二练对比：
 * - revise：只比 risk（降=改善）
 * - drill：只比 perf（升=改善）
 * 对应维度任一侧缺失 → 该条不产出（绝不产出 "−0" 这种看起来像坏了的数字）
 */
export function computeDelta(
  kind: 'drill' | 'revise',
  prevRisk: RiskCell[] | null,
  nowRisk: RiskCell[] | null,
  prevPerf: Array<{ dimension: Dimension; score: number | null }> | null,
  nowPerf: Array<{ dimension: Dimension; score: number | null }> | null,
): Delta {
  const out: Delta = { kind, risk: [], perf: [] };

  if (kind === 'revise' && prevRisk && nowRisk) {
    for (const d of DIMENSIONS) {
      const p = prevRisk.find((x) => x.dimension === d)?.risk_score;
      const n = nowRisk.find((x) => x.dimension === d)?.risk_score;
      if (p === null || p === undefined || n === null || n === undefined) continue;
      const diff = n - p;
      if (diff === 0) continue;
      out.risk.push({ dimension: d, prev: p, now: n, dir: diff > 0 ? 1 : -1, source: 'doc_diff' });
    }
  }

  if (kind === 'drill' && prevPerf && nowPerf) {
    for (const d of DIMENSIONS) {
      const p = prevPerf.find((x) => x.dimension === d)?.score;
      const n = nowPerf.find((x) => x.dimension === d)?.score;
      if (p === null || p === undefined || n === null || n === undefined) continue;
      const diff = (n ?? 0) - (p ?? 0);
      if (diff === 0) continue;
      out.perf.push({ dimension: d, prev: p, now: n, dir: diff > 0 ? 1 : -1, source: 'answer_diff' });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 5 · 二练对比的两个原料（落库 JSON → 可比较的结构）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把落库的 material_risk JSON 反序列化成 RiskCell[]。
 *
 * 【为什么接受 string】落库的是 TEXT 列；而调用方有时拿到的是已 JSON.parse 的值。
 * 两种都收，坏数据返回 null —— 二练对比不能因为一份旧报告格式不对就整页 500。
 */
function asArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseRiskCells(raw: unknown): RiskCell[] | null {
  const arr = asArray(raw);
  if (!arr) return null;
  const out: RiskCell[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const dimension = String(o.dimension ?? '') as Dimension;
    if (!DIMENSIONS.includes(dimension)) continue;
    const score = o.risk_score;
    out.push({
      dimension,
      risk_score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      claims: typeof o.claims === 'number' ? o.claims : 0,
      absence: typeof o.absence === 'number' ? o.absence : 0,
    });
  }
  return out.length > 0 ? out : null;
}

export function parsePerformanceRows(raw: unknown): Array<{ dimension: Dimension; score: number | null }> | null {
  const arr = asArray(raw);
  if (!arr) return null;
  const out: Array<{ dimension: Dimension; score: number | null }> = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const dimension = String(o.dimension ?? '') as Dimension;
    if (!DIMENSIONS.includes(dimension)) continue;
    const score = o.score;
    out.push({
      dimension,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    });
  }
  return out.length > 0 ? out : null;
}

/** 质疑点的最小可比形状（跨材料比对时只需要这几个字段） */
export type ClaimBrief = {
  id: string;
  type: string;
  dimension: string;
  risk: number;
  text: string;
  quote: string;
  locator_kind: string;
};

export type ClaimDiff = {
  prevTotal: number;
  nowTotal: number;
  /** 两次材料里都还在的质疑点条数 */
  kept: number;
  added: Array<{ text: string; dimension: string; risk: number }>;
  removed: Array<{ text: string; dimension: string; risk: number }>;
  /** 同一条质疑点风险上调（改材料没改对方向） */
  riskUp: Array<{ text: string; prevRisk: number; nowRisk: number }>;
  /** 同一条质疑点风险下调（改对了） */
  riskDown: Array<{ text: string; prevRisk: number; nowRisk: number }>;
  /** 上次是「该写没写」、这次补上了原文 —— 改材料最直接的成效 */
  absenceFilled: number;
  /** 上次能引原文、这次反而引不出来了 */
  absenceIntroduced: number;
};

/** 归一化：去掉空白与标点，只留文字主体（两次抽取的标点常不一样） */
function claimKey(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 两次材料的质疑点增删。
 *
 * 【为什么按"文本归一化"而不是 claim id】revise 换的是**另一份材料**，
 * 重新抽取后 claim id 全变，按 id 比会得到"100% 全删 100% 全加"的假结论。
 * 所以先用归一化文本对齐，再用引文兜底对齐（重写材料时正文可能微调，但引的那句话常常原样保留）。
 * 对齐不上的才是真正的"新增 / 消失"。
 */
export function claimDiffOf(
  prev: ClaimBrief[],
  now: ClaimBrief[],
  maxItems = 5,
): ClaimDiff {
  const byText = new Map<string, ClaimBrief>();
  for (const c of prev) {
    const k = claimKey(c.text);
    if (k && !byText.has(k)) byText.set(k, c);
  }
  const byQuote = new Map<string, ClaimBrief>();
  for (const c of prev) {
    const k = claimKey(c.quote);
    if (k.length >= 8 && !byQuote.has(k)) byQuote.set(k, c);
  }

  const usedPrev = new Set<string>();
  const matched: Array<{ prev: ClaimBrief; now: ClaimBrief }> = [];
  const added: ClaimBrief[] = [];

  for (const c of now) {
    const byT = byText.get(claimKey(c.text));
    const hit = byT && !usedPrev.has(byT.id) ? byT : null;
    const byQ = hit ? null : byQuote.get(claimKey(c.quote));
    const realHit = byQ && !usedPrev.has(byQ.id) ? byQ : hit;
    if (realHit) {
      usedPrev.add(realHit.id);
      matched.push({ prev: realHit, now: c });
    } else {
      added.push(c);
    }
  }

  const removed = prev.filter((c) => !usedPrev.has(c.id));

  const riskUp: ClaimDiff['riskUp'] = [];
  const riskDown: ClaimDiff['riskDown'] = [];
  let absenceFilled = 0;
  let absenceIntroduced = 0;
  for (const { prev: p, now: n } of matched) {
    if (n.risk > p.risk) riskUp.push({ text: n.text, prevRisk: p.risk, nowRisk: n.risk });
    if (n.risk < p.risk) riskDown.push({ text: n.text, prevRisk: p.risk, nowRisk: n.risk });
    if (p.locator_kind === 'absence' && n.locator_kind === 'quote') absenceFilled += 1;
    if (p.locator_kind === 'quote' && n.locator_kind === 'absence') absenceIntroduced += 1;
  }

  const brief = (c: ClaimBrief) => ({ text: c.text, dimension: c.dimension, risk: c.risk });
  const sortedByRisk = (list: ClaimBrief[]) => [...list].sort((a, b) => b.risk - a.risk);

  return {
    prevTotal: prev.length,
    nowTotal: now.length,
    kept: matched.length,
    added: sortedByRisk(added).slice(0, maxItems).map(brief),
    removed: sortedByRisk(removed).slice(0, maxItems).map(brief),
    riskUp: riskUp.slice(0, maxItems),
    riskDown: riskDown.slice(0, maxItems),
    absenceFilled,
    absenceIntroduced,
  };
}

/**
 * 二练对比的总入口：把上一份报告 + 这一场的聚合结果拼成 Delta。
 *
 * 返回 null 的三种情况都是"如实说没有"，而不是造一个 0 出来：
 *   · 本场不是复练（没有 drill_from）—— 没有上一场可比；
 *   · 上一场报告不存在或格式坏掉；
 *   · 两边可比的维度一个都不相交（computeDelta 会返回空数组，UI 显示"无可比较项"）。
 *
 * 【C17 铁律再看一遍】drill 只比 performance、revise 只比 risk。
 * 混着比会让 drill 用户看到一个恒等于 0 的风险分差 —— 那是"−0"，等于骗人。
 */
export function deltaFor(input: {
  kind: DeltaKind;
  prevReport: Record<string, unknown> | null;
  nowRisk: RiskCell[];
  nowPerf: Array<{ dimension: Dimension; score: number | null }>;
  prevClaims?: ClaimBrief[];
  nowClaims?: ClaimBrief[];
}): Delta | null {
  if (!input.prevReport) return null;
  const prevRisk = parseRiskCells(input.prevReport.material_risk);
  const prevPerf = parsePerformanceRows(input.prevReport.performance);
  if (!prevRisk && !prevPerf) return null;

  const delta = computeDelta(input.kind, prevRisk, input.nowRisk, prevPerf, input.nowPerf);
  if (input.kind === 'revise' && input.prevClaims && input.nowClaims) {
    delta.claims = claimDiffOf(input.prevClaims, input.nowClaims);
  }
  return delta;
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 5 · 质询风险看板（3 评委 × 4 维）
// ─────────────────────────────────────────────────────────────────────────────

/** 看板行：三类质疑各一行（行头标出占这一席的评委） */
export type BoardRow = {
  type: string;
  label: string;
  /** 占这个角色的评委；材料缺这类质疑时没有席位，如实为 null */
  judgeName: string | null;
  judgeId: string | null;
  /** 该角色的质疑点总数（= 这一行 4 格之和） */
  total: number;
  cells: BoardCell[];
};

export type BoardCell = {
  dimension: Dimension;
  label: string;
  /** 该（类型, 维度）组合的质疑点条数；0 表示材料里真的没有，不是"没算" */
  count: number;
  risk_score: number | null;
  absence: number;
  /** 本场真的问到了其中几条（任何人问的都算）；0 表示这一格本场没被质询过 */
  asked: number;
  /** 占席评委**本人**追问到的条数（按 turn.personaId 归因；无席位时恒为 0） */
  askedByJudge: number;
};

export const CLAIM_TYPE_ORDER = ['method', 'engineering', 'value'] as const;

export const CLAIM_TYPE_LABEL: Record<string, string> = {
  method: '方法论',
  engineering: '工程实现',
  value: '价值与创新',
};

export type BoardClaim = ClaimRow & { type: string; text: string; quote: string };

/**
 * 谁问了哪条 claim 的归因表。
 *
 * 【为什么归因到 turn 而不是"claim 的 dimension"】
 * 2026-11-01 阶段 4 修过一次同类错位：报告的 askedDims 若按 claim 维度收集，
 * depth 席位的评委可能问出 evidence 维的 claim（席位维度 ≠ claim 维度是常态），
 * 报告就会出现"risk_score=58 旁边写本场未覆盖"的自相矛盾。
 * 看板的「该评委提出的 claim 数」同理：**谁问的**要看 turn.personaId，不是 claim 归属。
 */
export type AskedAttribution = {
  /** 这场真被问到（question 非空）的 claim id → 提问评委的 persona id */
  byClaim: Map<string, string>;
};

/**
 * 质询风险看板。
 *
 * 【为什么行是「质疑类型」而不是「评委」】
 * 席位是（维度, 类型）对（见 lib/prompts/personas.v1.ts 的 planSeats）。
 * 若按评委分行，材料维度不足时 planSeats 允许**两位评委同为 method**，
 * 于是两行的 4 个格子会完全一样 —— 一张重复的表格会被读成"数据出错了"。
 * 按类型分行永远不重复，而且行头能标出是哪位评委占着这一席，
 * 因此界面看上去仍然是"3 评委 × 4 维"。
 *
 * 【格子里的数字怎么算】
 * 与左栏 material_risk 用的是**同一个** aggregateMaterialRisk（同一套权重），
 * 所以看板上某一行的加权不会与左栏对不上：评委能拿 claims 复算。
 */
export function boardOf(
  claims: BoardClaim[],
  personas: Array<{ id: string; name: string; role: string }>,
  askedClaimIds: Set<string>,
  /** 谁问了哪条 claim。缺省时退化成"不区分谁问的"（旧调用点兼容），归因列为空 */
  attribution?: AskedAttribution,
): BoardRow[] {
  return CLAIM_TYPE_ORDER.map((type) => {
    const rowsOfType = claims.filter((c) => c.type === type);
    const judge = personas.find((p) => p.role === type) ?? null;
    const cells: BoardCell[] = DIMENSIONS.map((dimension) => {
      const sub = rowsOfType.filter((c) => c.dimension === dimension);
      const cell = aggregateMaterialRisk(sub).find((x) => x.dimension === dimension)!;
      // 【按评委归因，而不是"这条 claim 属于谁"】
      // 指令包原文：「该评委提出的 claim 数」。一条 claim 被哪位评委追问过，
      // 记在 turn.personaId 上——depth 席位的评委完全可能追问一条 evidence 维的 claim
      // （追问咬住的是质疑点，不是维度）。按 claim 归属计数会让"追问数"永远等于"席位数"，
      // 看起来正常，其实是把归因整列丢掉了。
      const askedBySeatJudge = judge
        ? sub.filter((c) => attribution?.byClaim.get(c.id) === judge.id).length
        : 0;
      return {
        dimension,
        label: DIMENSION_LABEL[dimension],
        count: sub.length,
        risk_score: cell.risk_score,
        absence: cell.absence,
        // 本场问到 = 全场口径（任何人问过都算）；attribution 里的 asked = 这位评委本人问的
        asked: sub.filter((c) => askedClaimIds.has(c.id)).length,
        askedByJudge: askedBySeatJudge,
      };
    });
    return {
      type,
      label: CLAIM_TYPE_LABEL[type] ?? type,
      judgeName: judge?.name ?? null,
      judgeId: judge?.id ?? null,
      total: rowsOfType.length,
      cells,
    };
  });
}

/**
 * 覆盖度：「本场 6 轮，覆盖 3/4 维 · 完整评审请切 full 档」
 *
 * 【为什么要把轮数写进去】只写「覆盖 3/4 维」会让 quick 档看起来像做漏了。
 * 真实情况是 quick 只排得到 3 个主问，第 4 维根本轮不到——把轮数摆在前面，
 * 读者才知道这是档位选择的结果，而不是系统的缺口。缺的那一维由页面补一句
 * 「完整评审请切 full 档」，把"没做全"翻译成"可以继续"。
 */
export function coverageOf(
  risk: RiskCell[],
  perf: Array<{ dimension: Dimension; score: number | null }>,
  opts: { rounds?: number } = {},
) {
  const coveredRisk = risk.filter((r) => r.risk_score !== null).length;
  const coveredPerf = perf.filter((p) => p.score !== null).length;
  const covered = Math.max(coveredRisk, coveredPerf);
  const rounds = opts.rounds;
  return {
    risk: { covered: coveredRisk, total: DIMENSIONS.length },
    perf: { covered: coveredPerf, total: DIMENSIONS.length },
    // 没传轮数时退回旧文案（纯函数层不替调用方编造轮数）
    note:
      rounds === undefined
        ? `覆盖 ${covered}/${DIMENSIONS.length} 维`
        : `本场 ${rounds} 轮，覆盖 ${covered}/${DIMENSIONS.length} 维`,
  };
}

/** 高风险清单：按 risk 降序，absence 单独标（"该写没写"） */
export function highRiskOf(claims: Array<ClaimRow & { text?: string; quote?: string; section?: string | null; page?: number | null; block_idx?: number }>, max = 8) {
  return [...claims]
    .sort((a, b) => b.risk - a.risk)
    .slice(0, max)
    .map((c) => ({
      claimId: c.id,
      dimension: c.dimension,
      risk: c.risk,
      actionable: c.locator_kind === 'absence', // absence = 改材料即可消除
      quote: c.quote ?? '',
      section: c.section ?? null,
      page: c.page ?? null,
      blockIdx: c.block_idx ?? 0,
      text: c.text ?? '',
    }));
}

/** 「该写没写」的占比 —— 实用价值里最值钱的一句 */
export function actionabilityOf(claims: ClaimRow[]) {
  const total = claims.length;
  const absence = claims.filter((c) => c.locator_kind === 'absence').length;
  return { total, absence, ratio: total ? absence / total : 0 };
}

/** 报告的对外结构（落库行 → JSON）。GET /api/reports/:id 与 POST /end 共用，避免两处结构分叉。 */
export function reportPayloadOf(row: Record<string, unknown>, sessionId: string) {
  const parse = <T>(v: unknown, fallback: T): T => {
    if (v === null || v === undefined) return fallback;
    try {
      return JSON.parse(String(v)) as T;
    } catch {
      // 落库的 JSON 坏了不能让报告页整页挂掉：退回空结构，页面显示"本栏无数据"
      return fallback;
    }
  };
  return {
    sessionId,
    material_risk: parse(row.material_risk, []),
    performance: parse(row.performance, []),
    coverage: parse(row.coverage, null),
    high_risk: parse(row.high_risk, []),
    advice: String(row.advice ?? ''),
    delta: row.delta === null || row.delta === undefined ? null : parse(row.delta, null),
    createdAt: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
  };
}

export type BlockRef = Pick<Block, 'idx' | 'page' | 'section'>;
