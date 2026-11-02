// lib/prompts/report.v1.ts —— 答辩风险报告 prompt（v1）
//
// 【这一版最关键的一条：材料风险分**不由模型给**】
// C13 定的是服务端从 claims 聚合 `risk_score`（见 lib/report.ts）。
// 模型只写 comment + locators。理由不是"不信任模型"，而是三条硬事实：
//   ① 强制"4 维打分 + 每条 ≥1 条引用"叠加时，模型唯一出路是编引用——两头都会失真；
//   ② 同一批 claims 永远算出同一个 risk_score，评委能复算（可复现 25% 的落点）；
//   ③ "这条材料有多危险"是**材料本身**的属性，不该每场重新拍一次。
// 所以 prompt 里必须明文禁止模型输出分数，且 schema（ReportOut.material_risk）根本没有 score 字段。
//
// 【临场表现才由模型给分】
// performance.score 是 0–100，越大越好——与 risk_score（越大越糟）极性相反。
// 两条曲线的方向必须写进 prompt，否则模型会顺手把"风险高"翻译成"分数高"。
//
// 【两栏为什么必须分开写】
// 上一版把"材料问题"与"临场表现"混在一个 dimensions 数组里，产品就说不清：
// 用户看不出"我答得不好"和"我的材料本身有洞"是两件不同的事，也就不知道该改哪个。
// 现在左栏是可改的**材料**，右栏是本场可练的**表现**——这是 revise/drill 两条复练路径的前提。
//
// 【high_risk 只列真正会被追问崩的点】
// 上限 8 条。列满 8 条等于没排序；列 3 条精准的比列 8 条更值钱。
// 每条都要带 claim_id（报告要能点回原文那一句），这是锚点模型的最后一环。

import { ReportOut } from '../schemas';
import type { Locator } from '../locator';

export type ReportTurnInput = {
  personaName: string;
  question: string;
  answer: string | null;
  score: number | null;
  gaps: string | null;
  kind: string;
};

export type ReportClaimInput = {
  id: string;
  text: string;
  dimension: string;
  risk: number;
  type: string;
  quote: string;
  locatorKind: 'quote' | 'absence';
  section: string | null;
  page: number | null;
  /** 本场有没有被问到（没被问到的 claim 也算材料风险，但"没被追问到"本身是覆盖缺口） */
  askedInSession: boolean;
};

export type ReportInput = {
  docName: string;
  mode: string;
  modeLabel: string;
  /** 本场实际覆盖了哪几个维度（材料维度不足时少于 4） */
  coveredDimensions: string[];
  /** 真实聚合出来的材料风险（服务端算的，作为模型的**只读参考**，不许它改） */
  riskByDimension: Array<{ dimension: string; riskScore: number | null; claims: number }>;
  claims: ReportClaimInput[];
  turns: ReportTurnInput[];
  /** 本场被问到的 claim 的原文块（供 quote 复制的唯一来源） */
  sources: Array<{ blockIdx: number; text: string }>;
  /** 本场计划的主问数（报告里要写"3/3 已覆盖"这类覆盖说明） */
  qTotal: number;
};

export const REPORT_SYSTEM = `你是答辩委员会的主席，现在整场质询已经结束，你要写一份**答辩风险报告**。

【输出格式】
只输出一个 JSON 对象，包含四个字段：
{"material_risk": [...], "performance": [...], "high_risk": [...], "advice": "..."}
不要输出任何解释文字。

一、material_risk —— 材料本身的风险（**不许给分**）
每条：{"dimension": "logic|evidence|depth|expression", "comment": "≤200 字", "locators": [...]}
- comment 要写"这份材料在这一维上有什么洞"，写成判断，不要写建议。
  例："样本只来自 3 所学校，未交代抽样依据，推广到全市的结论缺一条支撑。"
- **绝对不许输出 score / risk_score / 分数**。材料风险分由服务端从质疑点聚合，你若给分就会与它冲突。
- 只写【本场覆盖到的维度】。材料本身没有的维度**不要写**（写了就是编）。

  locators 的**形状必须是一个对象，不能是字符串**（这一条踩过真实坑，见下文）：
    quote 类：{"kind":"quote","block_idx":12,"quote":"..."}
    absence 类：{"kind":"absence","block_idx":12,"scope":"第3章"}
  字段规则：
    · quote 必须从【给定原文块】里逐字复制连续的一段，8–60 字，不许改写、不许跨块拼接。
    · block_idx 必须是【给定原文块】里那个方括号标注的编号，**必须给**。
      只给一句引文而不给 block_idx，这条出处就失去了位置，无法被点回原文验证。
    · absence 用在"我查过但确实没有"时，scope 写查过的范围（章节名或 §3.2，≤60 字），quote 留空。
  可以给 0–6 条。宁可给空数组 []，也**不要编**一句原文里没有的话。

  反例（会被机检判失败、且会让整份报告报废）：
    "locators": ["我们认为该结论可以推广到全市"]   ← 字符串，没有 block_idx
  正例：
    "locators": [{"kind":"quote","block_idx":3,"quote":"我们认为该结论可以推广到全市"}]

二、performance —— 临场表现（**只有这一项给分**）
每条：{"dimension": "...", "score": 0-100 的整数, "comment": "≤200 字"}
- score **越大越好**（注意：material_risk 的分数方向与你无关，你不用给那边打分）。
- 依据是【本场问答记录】里考生的回答，不要凭空夸也不要凭空骂。
- 考生答不上来的维度可以 low，但**不要写 0**：0 分只会让用户觉得系统在羞辱他，
  而"没答上来"与"答得很差"在报告里应该是不同的表达（前者写进 comment，后者才压分）。
- 只写本场真正被问到的维度。

三、high_risk —— 最可能一问就崩的点（最多 8 条，宁可少而准）
每条：{"claim_id": "...", "question": "评委最可能怎么问（≤200 字）",
        "why": "为什么这里会被追问崩（≤160 字）", "suggestion": "改材料该怎么改（≤200 字）"}
- claim_id 必须是【质疑点清单】里真实存在的 id，原样复制，不许编。
- 按危险程度从高到低排；只列你真心认为危险的点，列满 8 条等于没排序。
- **若几条指向同一个根因**（例如"意愿当行为""数值无出处""标题措辞"其实是同一处
  概念与操作定义不一致），**合并成一条**，在 why 里点明这个根因在材料哪几处重复出现。
  把同一处缺口换成三种问法占掉三个名额，等于用条数冒充覆盖面。
- suggestion 要能落地：写"补一句什么""交代哪段范围"，不要写"加强论证"这种空话。

四、advice
≤600 字，整场的总建议。**不要重复上面各条已经说过的内容**，
只写"这三条串起来说明什么""下一场最该练什么"这类跨条目的判断。

【禁止】
- 不要给材料维度打分（第四条重复一次，因为模型最容易在这里越界）。
- 不要输出 material_risk / performance / high_risk / advice 以外的字段。
- 不要写"总体表现良好""继续努力"这类不承载信息的场面话。
- 不要在 comment 里重复 quote 的原句（引用卡片会单独展示）。`;

/** 把本场的问答记录与材料编译成报告输入 */
export function buildReportUser(input: ReportInput): string {
  const lines: string[] = [];

  lines.push(`材料：${input.docName}`);
  lines.push(`档位：${input.mode}（${input.modeLabel}）`);
  lines.push(`本场共 ${input.turns.filter((t) => t.kind === 'question').length} 个主问 + ${input.turns.filter((t) => t.kind === 'followup').length} 次追问。`);
  lines.push(`本场覆盖到的维度：${input.coveredDimensions.join('、') || '（无）'}`);
  lines.push('');

  lines.push('【材料风险（服务端已聚合，仅供你写评语时参考，**不许你输出分数**）】');
  for (const r of input.riskByDimension) {
    lines.push(
      `- ${r.dimension}：${r.riskScore === null ? '本场未覆盖（不要写这一维）' : `risk_score=${r.riskScore}（越大越危险）`}` +
        `，质疑点 ${r.claims} 条`,
    );
  }
  lines.push('');

  lines.push('【质疑点清单（high_risk 的 claim_id 只能从这里原样复制）】');
  for (const c of input.claims.slice(0, 14)) {
    const where = c.page !== null ? `P${c.page}` : c.section ?? '无章节';
    const loc = c.locatorKind === 'absence' ? `缺失·查过 ${c.section ?? '未标注'}` : `原文「${c.quote}」`;
    lines.push(
      `claim_id="${c.id}" 维度=${c.dimension} 风险=${c.risk}/5 位置=${where}` +
        `${c.askedInSession ? '（本场被问到）' : '（本场未被问到）'}`,
    );
    lines.push(`  ${c.text}`);
    lines.push(`  依据=${loc}`);
  }
  lines.push('');

  lines.push('【本场问答记录】');
  if (input.turns.length === 0) {
    lines.push('（本场没有作答记录。这是"评审中断后直接出报告"的情况：');
    lines.push('  performance 只能基于已有记录写，**不要编造考生说过的话**；');
    lines.push('  若一条回答都没有，performance 给空数组 []，让前端如实显示"本场无作答数据"。）');
  } else {
    for (const t of input.turns) {
      const tag = t.kind === 'followup' ? '（追问）' : '';
      lines.push(`- ${t.personaName}${tag}：${t.question}`);
      lines.push(`  考生回答：${t.answer === null || t.answer === '' ? '（未作答）' : t.answer}`);
      if (t.score !== null) lines.push(`  本问得分：${t.score}/5`);
      if (t.gaps) lines.push(`  已判定的缺口：${t.gaps}`);
    }
  }
  lines.push('');

  if (input.sources.length > 0) {
    lines.push('【给定原文块（quote 类出处必须从这里逐字复制）】');
    for (const s of input.sources) {
      lines.push(`[${s.blockIdx}] ${s.text}`);
      lines.push('');
    }
  }

  lines.push('请按系统提示输出 JSON。再次确认：material_risk 只有 dimension/comment/locators，没有 score。');
  return lines.join('\n');
}

export const ReportSchema = ReportOut;
export const REPORT_BATCH = 1;
export const REPORT_V1 = { version: 'v1' as const, system: REPORT_SYSTEM };

/** 报告里展示的维度中文名（与 lib/report.ts 的 DIMENSION_LABEL 同源） */
export const REPORT_DIM_LABEL: Record<string, string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};

/**
 * 模型给了 locators 但机检没过时，报告角的处理口径：
 * 保留条目、标 verified=0、**留在分母里**（与判分一致）。
 * 这个函数只是类型收口，真正的机检在 lib/locator.ts。
 */
export type ReportLocatorOut = Locator & { verified?: 0 | 1 | null };
