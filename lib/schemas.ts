// lib/schemas.ts —— LLM 输出契约（zod 4）。模型只说它知道的事，服务端负责回填与机检。
import { z } from 'zod';

export const DIM = z.enum(['logic', 'evidence', 'depth', 'expression']);
export const CLAIM_TYPE = z.enum(['method', 'engineering', 'value']);

/** 引用：quote 类要 8–60 字；absence 类必须给 scope（"我查了这一段，没有"） */
export const LocatorOut = z
  .object({
    kind: z.enum(['quote', 'absence']).default('quote'),
    block_idx: z.number().int().nonnegative(),
    quote: z.string().max(60).default(''),
    scope: z.string().max(60).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'quote') {
      if (v.quote.length < 8) ctx.addIssue({ code: 'custom', message: 'quote 至少 8 字', path: ['quote'] });
      if (v.quote.length > 60) ctx.addIssue({ code: 'custom', message: 'quote 最多 60 字', path: ['quote'] });
    } else if (!v.scope || v.scope.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: 'absence 必须给 scope', path: ['scope'] });
    }
  });

/** 1) 质疑点抽取。模型不输出 page/section（服务端按 block_idx 回填）。 */
export const ClaimsOut = z.object({
  claims: z
    .array(
      z.object({
        type: CLAIM_TYPE,
        text: z.string().min(4).max(120),
        block_idx: z.number().int().nonnegative(),
        kind: z.enum(['quote', 'absence']).default('quote'),
        quote: z.string().max(60).default(''),
        scope: z.string().max(60).optional(),
        risk: z.number().int().min(1).max(5),
        dimension: DIM,
      }),
    )
    .max(12), // 单批上限：防止一次抽爆
});

/** 2) 人设 + 首问 */
export const PersonasOut = z.object({
  personas: z
    .array(
      z.object({
        name: z.string().min(1).max(20),
        role: CLAIM_TYPE,
        focus: z.string().min(2).max(80),
        tone: z.string().min(1).max(40),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        opening: z
          .array(z.object({ claim_id: z.string().min(1), question: z.string().min(6).max(200) }))
          .min(1)
          .max(3),
      }),
    )
    .min(1)
    .max(3),
});

/** 3) 判分 + 追问 */
export const EvaluateOut = z
  .object({
    score: z.number().min(0).max(5),
    gaps: z.array(z.string().max(80)).max(4),
    locators: z.array(LocatorOut).min(1).max(4),
    followup: z
      .object({
        question: z.string().min(6).max(200),
        target_claim_id: z.string().min(1),
        resolved: z.boolean(),
      })
      .nullable(),
  });

/** 4) 报告：材料风险只写评语（分由服务端聚合），临场表现才由模型给分 */
export const ReportOut = z.object({
  material_risk: z
    .array(
      z.object({
        dimension: DIM,
        comment: z.string().min(4).max(200),
        locators: z.array(LocatorOut).max(6).default([]),
      }),
    )
    .max(4),
  performance: z
    .array(
      z.object({
        dimension: DIM,
        score: z.number().min(0).max(100),
        comment: z.string().max(200).default(''),
      }),
    )
    .max(4),
  high_risk: z
    .array(
      z.object({
        claim_id: z.string().min(1),
        question: z.string().min(4).max(200),
        why: z.string().min(4).max(160),
        suggestion: z.string().min(4).max(200),
      }),
    )
    .max(8),
  advice: z.string().max(600),
});

export type ClaimsOutT = z.infer<typeof ClaimsOut>;
export type PersonasOutT = z.infer<typeof PersonasOut>;
export type EvaluateOutT = z.infer<typeof EvaluateOut>;
export type ReportOutT = z.infer<typeof ReportOut>;
export type LocatorOutT = z.infer<typeof LocatorOut>;
