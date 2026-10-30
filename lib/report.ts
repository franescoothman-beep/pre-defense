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

/** 临场表现：模型给分，这里只做口径统一（缺维 → null，不补均值） */
export function normalizePerformance(rows: Array<{ dimension: string; score: number; comment?: string }>): Array<{ dimension: Dimension; score: number | null; comment: string }> {
  return DIMENSIONS.map((d) => {
    const hit = rows.find((r) => r.dimension === d);
    return { dimension: d, score: hit ? Math.max(0, Math.min(100, Math.round(hit.score))) : null, comment: hit?.comment ?? '' };
  });
}

export type Delta = {
  risk: Array<{ dimension: Dimension; prev: number; now: number; dir: -1 | 0 | 1; source: 'doc_diff' }>;
  perf: Array<{ dimension: Dimension; prev: number; now: number; dir: -1 | 0 | 1; source: 'answer_diff' }>;
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
  const out: Delta = { risk: [], perf: [] };

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

/** 覆盖度：「本场 6 轮，覆盖 3/4 维 · 完整评审请切 full 档」 */
export function coverageOf(risk: RiskCell[], perf: Array<{ dimension: Dimension; score: number | null }>) {
  const coveredRisk = risk.filter((r) => r.risk_score !== null).length;
  const coveredPerf = perf.filter((p) => p.score !== null).length;
  return {
    risk: { covered: coveredRisk, total: DIMENSIONS.length },
    perf: { covered: coveredPerf, total: DIMENSIONS.length },
    note: `覆盖 ${Math.max(coveredRisk, coveredPerf)}/${DIMENSIONS.length} 维`,
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

export type BlockRef = Pick<Block, 'idx' | 'page' | 'section'>;
