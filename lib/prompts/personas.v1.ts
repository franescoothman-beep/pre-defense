// lib/prompts/personas.v1.ts —— 三位评委的人设 + 首问（v1）
//
// 设计要点（每条都对应一个具体的失败模式）：
//
// 1) **三位评委的 dimension 必须两两不同**。
//    如果三位都盯"证据"，一场 quick 档下来用户在同一个维度上被问 3 遍，
//    报告里另外三个维度全是"未覆盖"——产品立刻显得单薄。
//    这里把 focus 的分配**写死在代码里**（按 claims 的 dimension 排序取前三），
//    不交给模型"自行错开"（模型做不到，它会挑最显眼的那条）。
//
// 2) **每位评委只拿自己类型的 claims**（L2 上下文分层）。
//    全量喂进去，模型会挑最尖锐的那条，结果三位问的是同一件事。
//
// 3) **不生成问题，只生成人设 + 从已有 claims 里选首问**。
//    这是与"自由协作 Agent 群"划清界线的地方：问题必须落在某条 claim 上，
//    否则它就没有锚点，也就没法溯源（整个创新点就没了）。
//
// 4) **color 由服务端决定，不让模型给**。
//    视觉规范里四个维度对应四个传统色（§3.2），颜色只编码数据、不当装饰。
//    让模型给颜色，它会给出 5 种随意的高饱和色，破坏整个视觉体系。

import { z } from 'zod';
import { PersonasOut } from '../schemas';
import type { CLAIM_TYPE, DIM } from '../schemas';

export type ClaimForPersona = {
  id: string;
  type: 'method' | 'engineering' | 'value';
  text: string;
  dimension: 'logic' | 'evidence' | 'depth' | 'expression';
  risk: number;
  page: number | null;
  section: string | null;
  quote: string;
  locatorKind: 'quote' | 'absence';
  verified: 0 | 1 | null;
};

/** 四维 → 传统色（写死，不让模型决定；与 app/globals.css 的 token 同源） */
export const DIM_COLOR: Record<'logic' | 'evidence' | 'depth' | 'expression', string> = {
  logic: '#8c5b3f', // 赭石
  evidence: '#7c6a8a', // 藕荷
  depth: '#3f6e63', // 竹青
  expression: '#4a6076', // 靛青
};

export const DIM_LABEL: Record<'logic' | 'evidence' | 'depth' | 'expression', string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};

export const PERSONAS_SYSTEM = `你是答辩现场的组织者，要为本场质询安排三位**互不重叠**的评审。

【输出格式】
只输出一个 JSON 对象：{"personas": [ ... ]}，不要输出解释文字。

每位评委的字段：
- "name": 姓氏式称呼，2–6 字，例如「周评委」「许教授」。不要用"AI助手"这类称呼。
- "role": "method" | "engineering" | "value" —— 这位评委负责的质疑类型
- "focus": 一句话说明这位评委专盯什么，8–40 字。要具体，不要写"全面把关"
- "tone": 一句话描述其提问风格，4–20 字。例如「语速慢，逼你补数据」「先肯定再追问」
- "opening": 数组，1–3 条，每条 {"claim_id": "...", "question": "..."}

【三条硬性要求】
1. **三位评委的质疑类型必须各不相同**：一位 method、一位 engineering、一位 value。
2. 每位评委的 "focus" 必须落在**不同的问题面**上，不要三个人都在问"数据够不够"。
3. **"opening" 里的 claim_id 只能从我给你该位评委的候选质疑点里选**，
   不要自己编号，不要选没有给你的。
   "question" 要**基于该条质疑点的原文**展开成一个真问题（15–60 字），
   要具体到能让人立刻开始回答，不要问"你怎么看"这种空话。

【禁止】
- 不要输出 color 字段（服务端按维度分配传统色）。
- 不要输出"评分""建议""总结"这类字段。
- 不要输出同一位评委问同一件事的两条 opening。`;

/** 按 dimension 分配三位评委的焦点，保证两两不同 */
export function assignDims(claims: ClaimForPersona[]): Array<ClaimForPersona['dimension']> {
  const want = ['evidence', 'logic', 'depth', 'expression'] as const;
  const present = new Set(claims.map((c) => c.dimension));
  const picked = want.filter((d) => present.has(d));
  // claims 覆盖不到的维度也要占位（否则 quick 档只有 2 位评委）
  for (const d of want) {
    if (picked.length >= 3) break;
    if (!picked.includes(d)) picked.push(d);
  }
  return picked.slice(0, 3);
}

/** 每类 claim 挑风险最高的几条当候选（避免一次喂太多） */
export function pickCandidates(claims: ClaimForPersona[], type: ClaimForPersona['type'], limit = 5) {
  return claims
    .filter((c) => c.type === type)
    .sort((a, b) => b.risk - a.risk)
    .slice(0, limit);
}

export function buildPersonasUser(claims: ClaimForPersona[]): string {
  const dims = assignDims(claims);
  const lines: string[] = [];
  lines.push('本场材料的质疑点如下。请为三位评委各选 1 条作为首问。');
  lines.push('');
  lines.push('【维度分配（必须严格对应，不许改）】');

  const types: Array<ClaimForPersona['type']> = ['method', 'engineering', 'value'];
  types.forEach((tp, i) => {
    const dim = dims[i] ?? 'logic';
    lines.push(`- 第 ${i + 1} 位：role="${tp}"，focus 必须关于「${DIM_LABEL[dim]}」`);
  });
  lines.push('');

  types.forEach((tp, i) => {
    const cands = pickCandidates(claims, tp);
    lines.push(`--- role="${tp}" 的候选质疑点（共 ${cands.length} 条）---`);
    if (cands.length === 0) {
      lines.push('（本类没有质疑点。请仍然生成这位评委，opening 只能引用其它类型的候选。）');
    }
    for (const c of cands) {
      const where = c.page !== null ? `P${c.page}` : c.section ?? '无章节';
      const loc = c.locatorKind === 'absence' ? `缺失·查过 ${c.section ?? '未标注'}` : `原文「${c.quote}」`;
      lines.push(`claim_id="${c.id}" 风险=${c.risk}/5 维度=${DIM_LABEL[c.dimension]} 位置=${where} 依据=${loc}`);
      lines.push(`  质疑点原文：${c.text}`);
      lines.push('');
    }
  });

  lines.push('请按系统提示输出 JSON。claim_id 必须是上面出现过的引号内原文，一字不差。');
  return lines.join('\n');
}

export const PersonasSchema = PersonasOut;
export const PERSONAS_BATCH = 1;
export const PERSONAS_V1 = { version: 'v1' as const, system: PERSONAS_SYSTEM };
