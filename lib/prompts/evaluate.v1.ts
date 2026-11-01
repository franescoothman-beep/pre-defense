// lib/prompts/evaluate.v1.ts —— 判分 + 追问 prompt（v1）
//
// 【这个 prompt 的难点不是"给个分"，而是三件互相牵制的事】
//
// 1) 给分要有锚点。只说"0–5 分，5 分最好"的 prompt，实测会给出一个几乎恒为 3 的分数
//    （模型的默认安全区），于是报告里"临场表现"永远 60 分上下，用户看不出自己改没改好。
//    所以这里**每一档都写死了判定条件**，并要求模型先写 gaps 再定 score ——
//    顺序反过来（先打分了再补理由）时，理由会退化成对分数的粉饰。
//
// 2) locators 至少 1 条，这是逼模型编引用的入口。
//    批判分聚合那条决策已经解决了"逼模型给 4 维打分"，但「每条评价都得有出处」这条仍然留着，
//    因为它是本作品创新主张的落点（anchor-verified）。缓解手段只能是 prompt 侧给足出口：
//      · 有可引用句 → quote 类，逐字复制，8–60 字
//      · 压根没有可引用句（"你该补对照组但你没写"）→ absence 类，给 scope
//    两者都是"合法出处"，不合法的是"编一句原文里没有的话"。
//
// 3) 追问不许换题。followup.target_claim_id 必须是**用户消息里给出的候选清单**中的一条，
//    不许自己编 id、不许指向已经问过的点。服务端会做一次归属校验，失配就当作"不追问"
//    （见 lib/grade.ts），宁可少问一次，也不让评委拿一个假锚点开问。
//    —— 这是"多角色顺序提问"和"自由协作 Agent 群"的最后一道分界线。
//
// 【这一版不做的】不给 4 维打分（C13：材料风险由服务端从 claims 聚合，模型不参与）、
// 不写总体评价（那是 report 阶段的事）、不给建议（用户要的是"我现在答得怎么样"）。

import { EvaluateOut } from '../schemas';

export type EvaluateCandidate = {
  id: string;
  type: string;
  text: string;
  risk: number;
  section: string | null;
  page: number | null;
  quote: string;
  locatorKind: 'quote' | 'absence';
};

export type EvaluateInput = {
  /** 发问的这位评委 */
  persona: { name: string; role: string; focus: string; tone: string };
  /** 这一问本身 */
  question: string;
  /** 这一问打在哪条质疑点上（含它的锚点，供模型判断"追得够不够"） */
  claim: {
    id: string;
    text: string;
    type: string;
    risk: number;
    quote: string;
    locatorKind: 'quote' | 'absence';
    section: string | null;
    page: number | null;
  } | null;
  /** 该 block 的完整原文：判"这个回答有没有对上这一段"要看上下文，不能只看 quote */
  source: string;
  /** 用户的回答 */
  answer: string;
  /** 本场还没被 targeting 过的质疑点（追问只能从这里面选，全局去重） */
  candidates: EvaluateCandidate[];
  /** 第几问 / 共几问，让模型知道这一场的进度（quick 只有 3 问，别问太发散） */
  qIndex: number;
  qTotal: number;
  /** 本问已经追问过几次（模型据此判断"该收口了没有"） */
  followupsSoFar: number;
};

export const EVALUATE_SYSTEM = `你是答辩现场的一位评委，刚刚问完一个问题，现在要评价考生的回答，并决定要不要追问。

【输出格式】
只输出一个 JSON 对象：
{"score": 0-5 的整数, "gaps": ["..."], "locators": [{...}], "followup": {...} 或 null}
不要输出任何解释文字。

【score 怎么给——五档写死，对号入座】
5 = 直接给了确切答案：有具体数字/方案/边界，听不出还缺什么
4 = 答案成立，只有一处细节可补（例如分母没给，但说清了是哪类样本）
3 = 方向对，但关键处含糊：只有结论没有依据，或只有依据没有结论
2 = 答非所问的成分开始明显：答的是另一个问题，或绕开了被问的那个词
1 = 基本没接上：复述问题、说"这个我们做了"但不讲怎么做的
0 = 空答、答非所问、或与材料自相矛盾

【gaps 怎么写】
先写 gaps（0–4 条，每条 ≤80 字），**再**根据 gaps 的严重程度定 score。
这个顺序不许颠倒：先定分数再补理由，理由会变成对分数的粉饰。
每条 gaps 只写"缺什么／哪里有矛盾"，不要写成建议（"你应该补……"是下一步的事）。
若真的一处都不缺，gaps 给 []，此时 score 应为 5 或 4。

【locators 怎么写——这是本产品能被机检的前提】
给 1–4 条出处，每条要么是 quote 类，要么是 absence 类：
- quote 类：{"kind":"quote","block_idx":N,"quote":"..."}
  quote 必须从【给定原文】里**逐字复制连续的一段，8–60 字**。
  不许改写、不许补字、不许跨块拼接、不许用省略号。
  block_idx 必须是【给定原文】里标注的那个块号。
- absence 类：{"kind":"absence","block_idx":N,"scope":"..."}
  用在你"查过但确实没有"的时候（例如考生该交代对照组而材料和回答里都没有）。
  scope 写你查过的范围（章节名或"§3.2"这类编号，≤60 字）。
  absence 的 quote 留空。
**绝不允许**编一句原文里并不存在的话来凑出处。编出来的引用会被逐字机检判 0，
既不帮到考生，也会让这次评价失去可信度。宁可给 absence，也不要编。

【followup 怎么写】
- 追问只能**咬住同一条质疑点**再深一层，不许换到别的话题上。
- "target_claim_id" 必须从【可追问的质疑点】清单里**原样复制一个 id**，
  不许自己编 id，不许用清单外的 id，也不许指向这一问已经问过的那条。
  若清单为空，或者没有值得再问的了，followup 给 null。
- "question" 15–60 字，一句话，要具体到能立刻开口回答。
  不要重复考生的答案，不要先讲一段背景再问。
- "resolved": 考生是否**已经答清了这条质疑点**。
  已经答清 → true（这一轮到此为止，换下一位）；
  还有明显没有交代的关键处 → false 并给出追问。
  **不要为了多问一轮而把已经答清的说成 false**：追问次数是有限的，
  浪费在已经答清的点上，就等于让另一个真正没答清的点没机会被问到。
- 若本问已经追问过 2 次，followup 一律给 null（收敛规则写在服务端，但你先配合它）。

【禁止】
- 不要给材料打分（材料风险分由服务端从质疑点聚合，与本评价无关）。
- 不要写总体评价、不要说场面话、不要输出 score/gaps/locators/followup 以外的字段。
- 不要在 question 里复述考生的原话。`;

/** 从素材里抽出可引用的块编号（prompt 里的 block_idx 必须与之对应） */
export function buildEvaluateUser(input: EvaluateInput): string {
  const { persona, question, claim, source, answer, candidates, qIndex, qTotal, followupsSoFar } = input;
  const lines: string[] = [];

  lines.push(`你是：${persona.name}，风格是「${persona.tone}」`);
  lines.push(`你的关注点：${persona.focus}`);
  lines.push(`这是第 ${qIndex} / ${qTotal} 问，本问已追问 ${followupsSoFar} 次。`);
  lines.push('');

  lines.push('【你提的问题】');
  lines.push(question);
  lines.push('');

  if (claim) {
    lines.push('【这个问题打在哪条质疑点上】');
    lines.push(`质疑点：${claim.text}（类型 ${claim.type} · 风险 ${claim.risk}/5）`);
    if (claim.locatorKind === 'absence') {
      lines.push(`依据：缺失类——原文里没有可直接引用的句子（已检索范围：${claim.section ?? '未标注'}）`);
    } else {
      lines.push(`依据原文：「${claim.quote}」`);
    }
    lines.push('');
  }

  if (source) {
    lines.push('【给定原文（quote 类出处必须从这里逐字复制）】');
    lines.push(source);
    lines.push('');
  }

  lines.push('【考生的回答】');
  lines.push(answer.trim() ? answer : '（考生没有作答，交了空。）');
  lines.push('');

  if (candidates.length > 0) {
    lines.push('【可追问的质疑点（target_claim_id 只能从这里原样复制）】');
    for (const c of candidates.slice(0, 6)) {
      const where = c.page !== null ? `P${c.page}` : c.section ?? '无章节';
      const loc = c.locatorKind === 'absence' ? `缺失·查过 ${c.section ?? '未标注'}` : `原文「${c.quote}」`;
      lines.push(`claim_id="${c.id}" 风险=${c.risk}/5 位置=${where} 依据=${loc}`);
      lines.push(`  ${c.text}`);
    }
    lines.push('');
  } else {
    lines.push('【可追问的质疑点】');
    lines.push('（本场质疑点都已问过，没有可追问的新点 → followup 必须给 null）');
    lines.push('');
  }

  lines.push('请按系统提示输出 JSON：先写 gaps，再定 score，再给 locators，最后给 followup。');
  return lines.join('\n');
}

export const EvaluateSchema = EvaluateOut;
export const EVALUATE_BATCH = 1;
export const EVALUATE_V1 = { version: 'v1' as const, system: EVALUATE_SYSTEM };

/** 五档标签（前端展示 score 时给中文解释，不让用户对着数字猜） */
export const SCORE_LABEL: Record<number, string> = {
  0: '空答或答非所问',
  1: '基本没接上',
  2: '明显绕开了被问的点',
  3: '方向对但关键处含糊',
  4: '成立，只差一处细节',
  5: '答清了',
};

/** 把 0–5 的 score 转成 0–100 的展示值（与 performance.score 同一口径，C14） */
export function scoreToPercent(score: number): number {
  const clamped = Math.max(0, Math.min(5, score));
  return Math.round((clamped / 5) * 100);
}
