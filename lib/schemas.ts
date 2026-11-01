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

/**
 * 报告里的 locator：**允许模型把它写成一句纯字符串**。
 *
 * 【这条容错是真实事故换来的，不是防御性编程】
 * 2026-11-01 真实 key 出报告时，模型返回的是：
 *   "locators": ["我们认为该结论可以推广到全市乃至全省的课后服务管理场景", ...]
 * 而约定是 `[{kind, block_idx, quote}]`。结果：整份报告的 zod 校验失败，
 * `POST /end` 静默降级成模板（用户拿到一份"没有模型评语"的报告），
 * 而**那份被丢掉的原始输出质量其实很高**——四维评语、8 条高风险清单、advice 全部到位。
 * 一个形状瑕疵让一整份好报告报废，这个代价不能接受。
 *
 * 为什么可以这样规整而不是"猜"：
 *   字符串本身**就是** quote 的内容，唯一缺的是位置（block_idx）。
 *   所以规整时补 block_idx = -1，交给 lib/locator.ts 机检判越界 → verified=0，
 *   它会被如实标成"未校验"并进入命中率分母，**不会被当成合法出处**。
 *   这样既不丢内容，也不假装它被验证过——这正是容错与编数据的界线。
 *
 * 【为什么这里不能用 LocatorOut 的 .nonnegative()】
 * 那份 schema 的 block_idx 不允许 -1，而 -1 正是"位置未知"的哨兵值。
 * 硬套会让规整后的对象又在校验处被拒，容错变成无效代码。
 * 所以这里把 block_idx 放宽到允许 -1，但**其余字段与长度规则完全沿用 LocatorOut 的语义**；
 * 并且真正的"这个位置能不能用"由 attachReportLocator 在机检时决定。
 */
export const ReportLocatorIn = z.preprocess(
  (v) => {
    if (typeof v === 'string') {
      // 模型写成裸字符串：把它当 quote，位置标 -1（必然机检失败，标为未校验）
      return { kind: 'quote', block_idx: -1, quote: v };
    }
    return v;
  },
  z
    .object({
      kind: z.enum(['quote', 'absence']).default('quote'),
      // 允许 -1（位置未知）；真实位置必须为非负整数，由机检把关
      block_idx: z.number().int().min(-1),
      quote: z.string().max(60).default(''),
      scope: z.string().max(60).optional(),
    })
    .superRefine((v, ctx) => {
      if (v.kind === 'quote') {
        if (v.quote.length < 8) ctx.addIssue({ code: 'custom', message: 'quote 至少 8 字', path: ['quote'] });
      } else if (!v.scope || v.scope.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: 'absence 必须给 scope', path: ['scope'] });
      }
    }),
);

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

/**
 * 2.5) 单条提问（SSE 流式专用）
 *
 * 与 PersonasOut 分开的原因：人设只生成一次（把三个席位、名字、风格定下来），
 * 而**每一次提问都要单独调一次模型**，且这次调用要流式吐字。
 * 若把它们合在一起，quick 档三位评委就只能在创建会话时把三问全算好，
 * 那样"追问"（阶段 4）就没法根据用户的回答动态出题了。
 *
 * 只给 `question` 一个字段，不给答分、不给 locator —— 出处由服务端按 claimId 装配，
 * 模型无权在提问时更换锚点（换了锚点就等于可以随口编一个出处）。
 */
export const QuestionOut = z.object({
  question: z.string().min(6).max(200),
});

/** 3) 判分 + 追问 */
export const EvaluateOut = z
  .object({
    score: z.number().min(0).max(5),
    // gaps 上限 4：模型偶尔给 5 条（每条的严重程度不同）。
    // 截断比整份失败合理——判分结果丢掉会让用户"答了一次白答"。
    // 保留前 4 条：模型按严重程度先写严重的，顺序本身有信息。
    gaps: z.preprocess((v) => (Array.isArray(v) ? v.slice(0, 4) : v), z.array(z.string().max(80)).max(4)),
    // locators 上限 4：同理截断。**但 min(1) 不改**——
    // "每条评价至少一条出处"是产品的硬承诺（anchor-verified 的落点），
    // 少于 1 条就说明这条评价无法溯源，必须让它失败并重试。
    locators: z.preprocess(
      (v) => (Array.isArray(v) ? v.slice(0, 4) : v),
      z.array(LocatorOut).min(1).max(4),
    ),
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
    .preprocess(
      // 【多出来的条目按 dimension 去重，而不是直接截断】
      // 第二个真实事故（2026-11-01）：模型给了 5 条 material_risk ——
      // 某个维度写了两遍（"证据"先写一条，后面又补一条）。zod 的 .max(4) 直接判整份失败，
      // 报告又降级成模板。
      // 简单 slice(0,4) 是错的：它可能留下第一条潦草的、丢掉后面那条更具体的，
      // 而且丢掉哪一维完全取决于模型的输出顺序。
      // 去重的语义才是对的：一个维度就该只有一条评语，保留**较完整的那条**（后写的通常更具体）。
      (arr) => {
        if (!Array.isArray(arr)) return arr;
        const byDim = new Map<string, Record<string, unknown>>();
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const dim = String((item as Record<string, unknown>).dimension ?? '');
          const prev = byDim.get(dim);
          const cur = item as Record<string, unknown>;
          // 保留评语更长的那一条（信息量更大的），而不是"后写的那条"
          if (!prev || String(cur.comment ?? '').length >= String(prev.comment ?? '').length) {
            byDim.set(dim, cur);
          }
        }
        return [...byDim.values()];
      },
      z
        .array(
          z.object({
            dimension: DIM,
            comment: z.string().min(4).max(200),
            // 【用 ReportLocatorIn 而不是 LocatorOut】模型实测会把这里写成纯字符串数组，
            // 用宽松版规整后才能保留那份本来合格的报告（理由见 ReportLocatorIn 的注释）。
            locators: z.array(ReportLocatorIn).max(6).default([]),
          }),
        )
        .max(4),
    ),
  performance: z
    .preprocess(
      // 与 material_risk 同一个道理：一个维度只该有一个分。模型偶尔会把某维写两遍，
      // .max(4) 会因此把整份报告判死。按 dimension 去重，保留分数更低的那个——
      // 【为什么保留更低】临场表现是"越大越好"，若模型重复给分说明它自己也没定，
      // 此时取更保守的那个，避免把一个答得不充分的一维美化成好分。
      (arr) => {
        if (!Array.isArray(arr)) return arr;
        const byDim = new Map<string, Record<string, unknown>>();
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const dim = String((item as Record<string, unknown>).dimension ?? '');
          const prev = byDim.get(dim);
          const cur = item as Record<string, unknown>;
          const curScore = Number(cur.score);
          const prevScore = prev ? Number((prev as Record<string, unknown>).score) : Number.POSITIVE_INFINITY;
          if (!prev || (Number.isFinite(curScore) && curScore < prevScore)) {
            byDim.set(dim, cur);
          }
        }
        return [...byDim.values()];
      },
      z
        .array(
          z.object({
            dimension: DIM,
            score: z.number().min(0).max(100),
            comment: z.string().max(200).default(''),
          }),
        )
        .max(4),
    ),
  high_risk: z
    .preprocess(
      // high_risk 的语义是"按危险程度排序后的前 N 条"，所以这里**截断是对的**：
      // 模型给多了就是没舍得排序，取前 8 条正好对应"最多 8 条"的业务口径。
      // （与 material_risk 不同：那边是"每个维度恰好一条"，去重才是对的语义。）
      (arr) => (Array.isArray(arr) ? arr.slice(0, 8) : arr),
      z
        .array(
          z.object({
            claim_id: z.string().min(1),
            question: z.string().min(4).max(200),
            why: z.string().min(4).max(160),
            suggestion: z.string().min(4).max(200),
          }),
        )
        .max(8),
    ),
  advice: z.string().max(600),
});

export type ClaimsOutT = z.infer<typeof ClaimsOut>;
export type PersonasOutT = z.infer<typeof PersonasOut>;
export type EvaluateOutT = z.infer<typeof EvaluateOut>;
export type ReportOutT = z.infer<typeof ReportOut>;
export type LocatorOutT = z.infer<typeof LocatorOut>;
