// lib/prompts/question.v1.ts —— 单次提问的 prompt（SSE 流式出题）
//
// 与人设 prompt 的分工：
//   personas.v1 = 这一场有哪几位评委、各自盯哪个维度（会话创建时跑一次）
//   question.v1 = 这位评委现在要对**这一条质疑点**说一句什么（每问一次，流式输出）
//
// 三条设计约束：
//
// 1) **问题必须从给定 claim 出发，不许换题**。
//    锚点在生成人设时就已经定死（claim_id + block_idx + quote），
//    这里是"把那条质疑点展开成一个真问题"。若允许模型自由发挥，
//    它会给一个听起来很棒但原文里根本没有依据的问题——整个溯源创新点失效。
//
// 2) **只输出 {"question": "..."}，不要口头禅、不要自我介绍**。
//    流式出的是"评委说的那一个字一个字"，前面若带一句"好的，作为方法论评委我认为"，
//    聊天页就会显示评委在自言自语。说话风格由 tone 控制，但不许出现在正文里。
//
// 3) **长度 15–60 字，一句问到底**。两句话会拖长首问、也让"流式"显得慢；
//    过短则退化成"你怎么看"这种空话。

import { QuestionOut } from '../schemas';

export type QuestionInput = {
  persona: { name: string; role: string; tone: string; focus: string };
  /** 该席位对应的维度标签，例如「证据」 */
  dimLabel: string;
  /** 已抽出的质疑点：这是本次提问的唯一依据 */
  claim: {
    id: string;
    type: string;
    text: string;
    risk: number;
    section: string | null;
    page: number | null;
    quote: string;
    locatorKind: 'quote' | 'absence';
    verified: 0 | 1 | null;
  };
  /** 该 block 的完整原文：模型据此判断"这句话到底在说什么"，避免断章取义 */
  source: string;
  /** 第几问 / 共几问，让评委知道自己还有多少时间（quick 档只有 1 问，语气要收敛） */
  qIndex: number;
  qTotal: number;
  /** 材料的整体身份（论文 / 简历 / 项目文档），影响提问口吻 */
  docName: string;
};

export const QUESTION_SYSTEM = `你是答辩现场的一位评委，现在轮到你对考生发问。

【输出格式】
只输出一个 JSON 对象：{"question": "..."}，不要输出任何解释文字。

【唯一的依据】
用户消息里会给你一条「质疑点」和它所在段落的原文。你的问题必须**只针对这一条**展开，
不许换成别的主题，也不许额外引入材料里没有的事实。

【问题怎么写】
- 15–60 字，**一句话问到底**。不要两问叠在一起，不要先讲一段背景再问。
- 要具体到考生能立刻开口回答：问"你用什么方式验证的""这个数字的分母是什么"，
  不要问"你怎么看""你觉得呢"这种空话。
- 用你自己的语气（见给出的 tone），但**不要在正文里自我介绍、不要出现"作为XX评委""我注意到"这类开场**。
  聊天页会单独显示你的名字与身份，正文重复一遍就成了自言自语。
- 若质疑点是"缺失类"（原文里没有可引用的句子），问题要指向**考生该补什么**，
  不要假装原文里有一句你没看到的话。

【禁止】
- 不要在问题里重复引用原文的整句话（引用卡片会单独展示，重复一遍显得啰嗦）。
- 不要给出评分、建议或总结。
- 不要输出 question 以外的任何字段。`;

export function buildQuestionUser(input: QuestionInput): string {
  const { persona, claim, source, qIndex, qTotal, docName, dimLabel } = input;
  const lines: string[] = [];

  lines.push(`材料：${docName}`);
  lines.push(`你是：${persona.name}，负责${dimLabel}维度，风格是「${persona.tone}」`);
  lines.push(`你的关注点：${persona.focus}`);
  lines.push(`这是第 ${qIndex} / ${qTotal} 问。`);
  lines.push('');

  lines.push('【本次要展开的质疑点】');
  lines.push(`类型：${claim.type} · 风险 ${claim.risk}/5` +
    (claim.section ? ` · 章节 ${claim.section}` : '') +
    (claim.page !== null ? ` · P${claim.page}` : ''));
  lines.push(`质疑点：${claim.text}`);
  if (claim.locatorKind === 'absence') {
    lines.push(`依据：缺失类——原文里没有可直接引用的句子（已检索范围：${claim.section ?? '未标注'}）`);
  } else {
    lines.push(`依据原文：「${claim.quote}」（逐字机检${claim.verified === 1 ? '命中' : '未命中'}）`);
  }
  lines.push('');

  if (source) {
    lines.push('【该质疑点所在段落的原文（供你判断上下文，不要在问题里整句重复）】');
    lines.push(source);
    lines.push('');
  }

  lines.push('请按系统提示输出 JSON，把这条质疑点展开成一个具体、能立刻回答的问题。');
  return lines.join('\n');
}

export const QuestionSchema = QuestionOut;
export const QUESTION_BATCH = 1;
export const QUESTION_V1 = { version: 'v1' as const, system: QUESTION_SYSTEM };

/** 维度标签（与 personas.v1 的 DIM_LABEL 同源，这里只需要中文名） */
export const DIM_LABEL_4 = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
} as const;

/** 从 claim 的 dimension 取标签；未知时回落到"材料本身" */
export function dimLabelOf(dimension: string): string {
  return (DIM_LABEL_4 as Record<string, string>)[dimension] ?? '材料本身';
}
