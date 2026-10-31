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
  /** 溯源锚点：聊天页「扫读原文思考态」按它去 blocks 表取原文 */
  blockIdx: number;
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

export const PERSONAS_SYSTEM = `你是答辩现场的组织者，要为本场质询安排若干位**互不重叠**的评审。

【输出格式】
只输出一个 JSON 对象：{"personas": [ ... ]}，不要输出解释文字。

每位评委的字段：
- "name": 姓氏式称呼，2–6 字，例如「周评委」「许教授」。不要用"AI助手"这类称呼。
- "role": "method" | "engineering" | "value" —— **照抄【席位分配表】给该位的 role，不许改**
- "focus": 一句话说明这位评委专盯什么，8–40 字。要具体，不要写"全面把关"
- "tone": 一句话描述其提问风格，4–20 字。例如「语速慢，逼你补数据」「先肯定再追问」
- "opening": 数组，1–3 条，每条 {"claim_id": "...", "question": "..."}

【三条硬性要求】
1. **严格按【席位分配表】输出，位数不许增减**。表里有几席就输出几位；
   每位的 "role" 与 "focus" 所对的维度必须与表里该席位一致，不许调换、不许合并。
2. **每位评委的 "opening" 只能从该席位自己的候选清单里选 claim_id**。
   不许跨席位借用别的类型或别的维度的质疑点，也不许自己编号、编造或选清单外的 id。
   "question" 要**基于该条质疑点的原文**展开成一个真问题（15–60 字），
   要具体到能让人立刻开始回答，不要问"你怎么看"这种空话。
3. 各席位已把维度错开，你就按各自维度问；**不许几位移到同一件事上**，
   不要都去问"数据够不够"。

【禁止】
- 不要输出 color 字段（服务端按维度分配传统色）。
- 不要输出"评分""建议""总结"这类字段。
- 不要输出同一位评委问同一件事的两条 opening。`;

const DIM_ORDER = ['evidence', 'logic', 'depth', 'expression'] as const;
const TYPE_ORDER = ['method', 'engineering', 'value'] as const;

/**
 * 一个评委席位 = 一个（维度, 类型）组合 + 属于它的候选质疑点。
 *
 * 【为什么按"实际存在的组合"分席位，而不是按"三位类型必须各不相同"】
 * 2026-10-31 真实 key 首跑暴露的缺陷：样例材料 12 条 claim 分布是
 * method 10 / engineering **0** / value 2。按"类型齐全"硬分三位时，
 * 负责 engineering 的那位永远找不到自己类型的问题，只能借别人的 claim 去问
 * ——首问从「工程实现」滑成「因果推断链条」，这就是串味（DoD 第 1 条直接不达标）。
 * 材料的质疑点类型是**材料本身决定**的，硬凑只会让三个评委问同一件事。
 * 所以改成按真实存在的维度分席位：维度两两不同（这是"不串味"的实质，
 * 也是报告左栏 risk_score 能覆盖三栏的前提），类型跟随该维度下真实条数最多的那类。
 * 材料确实缺某个类型时，宁可两位评委同为 method 但**维度不同**，
 * 也不假装有一个 engineering 评委。缺哪些维度会如实写在 coverage 里。
 */
export type PersonaSeat = {
  dim: ClaimForPersona['dimension'];
  type: ClaimForPersona['type'];
  candidates: ClaimForPersona[];
};

/**
 * 按实际存在的（维度, 类型）组合排出 want 个席位。
 *
 * 排序规则：claim 条数多的维度优先（材料真正有东西可问的地方先上），
 * 同数时按 DIM_ORDER；类型优先选还没被占用的类型（让角色尽量多样），其次选条数多的。
 * 若真实维度不足 want 个（少于 4 种维度有 claim，且 want > 维度数），才回退用同维度下的
 * 另一种类型补位，此时会出现两个席位维度相同——调用方用 `coverage` 如实报给前端，
 * 不要默认它是"四位评委齐全"。
 */
export function planSeats(claims: ClaimForPersona[], want = 3): PersonaSeat[] {
  const groups = new Map<string, ClaimForPersona[]>();
  for (const c of claims) {
    const key = `${c.dimension}|${c.type}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const dimTotals = new Map<ClaimForPersona['dimension'], number>();
  for (const c of claims) dimTotals.set(c.dimension, (dimTotals.get(c.dimension) ?? 0) + 1);

  const dims = [...dimTotals.keys()].sort((a, b) => {
    const diff = dimTotals.get(b)! - dimTotals.get(a)!;
    if (diff !== 0) return diff;
    return DIM_ORDER.indexOf(a) - DIM_ORDER.indexOf(b);
  });

  const seats: PersonaSeat[] = [];
  const usedTypes = new Set<string>();

  const pushSeat = (dim: ClaimForPersona['dimension'], type: ClaimForPersona['type']) => {
    const cands = groups.get(`${dim}|${type}`);
    if (!cands || cands.length === 0) return;
    usedTypes.add(type);
    seats.push({
      dim,
      type,
      candidates: [...cands].sort((a, b) => b.risk - a.risk).slice(0, 5),
    });
  };

  // 第一轮：每个维度取一个席位，保证维度两两不同
  for (const dim of dims) {
    if (seats.length >= want) break;
    const typeCounts = TYPE_ORDER.map((tp) => ({
      tp,
      n: groups.get(`${dim}|${tp}`)?.length ?? 0,
    })).filter((x) => x.n > 0);
    if (typeCounts.length === 0) continue;

    typeCounts.sort((a, b) => {
      // 没用过的类型优先（角色多样），其次条数多的优先，最后按固定顺序
      const ua = usedTypes.has(a.tp) ? 1 : 0;
      const ub = usedTypes.has(b.tp) ? 1 : 0;
      if (ua !== ub) return ua - ub;
      if (a.n !== b.n) return b.n - a.n;
      return TYPE_ORDER.indexOf(a.tp) - TYPE_ORDER.indexOf(b.tp);
    });
    pushSeat(dim, typeCounts[0].tp);
  }

  // 第二轮（仅在真实维度不足时触发）：用剩余的（维度,类型）组合补位
  if (seats.length < want) {
    const leftovers: Array<PersonaSeat> = [];
    for (const key of groups.keys()) {
      const sep = key.indexOf('|');
      const dim = key.slice(0, sep) as ClaimForPersona['dimension'];
      const type = key.slice(sep + 1) as ClaimForPersona['type'];
      if (seats.some((s) => s.dim === dim && s.type === type)) continue;
      const cands = groups.get(key)!;
      leftovers.push({
        dim,
        type,
        candidates: [...cands].sort((a, b) => b.risk - a.risk).slice(0, 5),
      });
    }
    leftovers.sort((a, b) => b.candidates.length - a.candidates.length);
    for (const s of leftovers) {
      if (seats.length >= want) break;
      seats.push(s);
    }
  }

  return seats.slice(0, want);
}

/** 某席位允许的 claim_id 集合（路由用它做锚点归属校验） */
export function seatClaimIds(seat: PersonaSeat): Set<string> {
  return new Set(seat.candidates.map((c) => c.id));
}

export function buildPersonasUser(claims: ClaimForPersona[], want = 3): string {
  const seats = planSeats(claims, want);
  const lines: string[] = [];
  lines.push(`本场材料共 ${claims.length} 条质疑点。请为下面 ${seats.length} 位评委各选首问。`);
  lines.push('');
  lines.push('【席位分配表（必须严格对应，不许改）】');

  seats.forEach((s, i) => {
    lines.push(
      `- 第 ${i + 1} 位：role="${s.type}"，focus 必须关于「${DIM_LABEL[s.dim]}」，只能从下方「第 ${i + 1} 位候选」里选`,
    );
  });
  lines.push('');

  seats.forEach((s, i) => {
    lines.push(
      `--- 第 ${i + 1} 位候选：role="${s.type}" · ${DIM_LABEL[s.dim]} · 共 ${s.candidates.length} 条 ---`,
    );
    for (const c of s.candidates) {
      const where = c.page !== null ? `P${c.page}` : c.section ?? '无章节';
      const loc =
        c.locatorKind === 'absence' ? `缺失·查过 ${c.section ?? '未标注'}` : `原文「${c.quote}」`;
      lines.push(
        `claim_id="${c.id}" 风险=${c.risk}/5 维度=${DIM_LABEL[c.dimension]} 位置=${where} 依据=${loc}`,
      );
      lines.push(`  质疑点原文：${c.text}`);
    }
    lines.push('');
  });

  lines.push(
    '请按系统提示输出 JSON：每位评委的 claim_id 必须是**属于该席位候选清单**里的引号内原文，一字不差；不许跨席位借用。',
  );
  return lines.join('\n');
}

export const PersonasSchema = PersonasOut;
export const PERSONAS_BATCH = 1;
export const PERSONAS_V1 = { version: 'v1' as const, system: PERSONAS_SYSTEM };
