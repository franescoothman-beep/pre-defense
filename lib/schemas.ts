// lib/schemas.ts —— LLM 输出契约（zod 4）。模型只说它知道的事，服务端负责回填与机检。
import { z } from 'zod';

export const DIM = z.enum(['logic', 'evidence', 'depth', 'expression']);
export const CLAIM_TYPE = z.enum(['method', 'engineering', 'value']);

/**
 * 宽容的「块号」输入：接受 3、"[3]"、"（3）"、"block 3" 等常见写法，统一转成整数。
 *
 * 【为什么不在 schema 层直接拒绝】
 * 实测真实 DeepSeek 会照抄 prompt 里的方括号，输出 `"block_idx": "[3]"`。
 * 若这里只收 number，**整批 5 条会全部报废**——一个格式瑕疵让整批数据消失，
 * 而内容本身是完全正确的。
 *
 * 边界很明确：只**规整格式**（去掉括号、空格、前缀），
 * 绝不**猜测含义**（"大概是指第 3 块吧"）。规整不出来的仍然是 null → 由 schema 拒绝。
 * 这条界线决定了我们是在"容错"还是在"编数据"。
 */
export const BlockIdxIn = z.preprocess((v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const m = /\d+/.exec(v.replace(/[/\\]/g, ''));
    if (m) return Number(m[0]);
  }
  return v; // 交给下面的 number 校验，让错误如实暴露
}, z.number().int().nonnegative());

/**
 * 宽容的 dimension：模型会把 dimension 与 type 混用（实测给出 "method"）。
 *
 * 这里做一次**有依据的映射**，而不是丢弃：
 *   method / engineering → depth（技术细节是否经得起追问）
 *   value / innovation   → expression（价值叙述是否清楚）
 * 两条映射都写在这里而不是散在业务代码里，便于审计。
 * 若给了完全无关的值（如 "color"），仍然拒绝——不做无根据的默认填充。
 */
export const DimIn = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim().toLowerCase();
  const map: Record<string, string> = {
    method: 'depth',
    engineering: 'depth',
    value: 'expression',
    innovation: 'expression',
  };
  return map[t] ?? t;
}, DIM);

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
        block_idx: BlockIdxIn,
        kind: z.enum(['quote', 'absence']).default('quote'),
        quote: z.string().max(60).default(''),
        scope: z.string().max(60).optional(),
        risk: z.number().int().min(1).max(5),
        dimension: DimIn,
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
        // 【不要 color】颜色由服务端按维度分配（§3.2「颜色只编码数据」）。
        // 让模型给颜色，它会给出五种随意的高饱和色，破坏整个视觉体系；
        // 更糟的是这里若把 color 设成必填，system prompt 又明文禁止模型输出它，
        // 模型照 prompt 做 → zod 必然失败 → POST /api/sessions 100% 挂 502。
        // 这个矛盾只有真实 key 会暴露：mock 回放里 fixture 是我自己写的，带不带 color 都不报错。
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
