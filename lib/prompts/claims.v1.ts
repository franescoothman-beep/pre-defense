// lib/prompts/claims.v1.ts —— 质疑点抽取 prompt（v1）
//
// 设计原则（每条都对应一个具体的失败模式）：
//
// 1) **每批只喂 5 块**。喂整篇 2400 块时，模型会挑最显眼的几句反复说，
//    且 quote 定位准确率断崖下降（块号越大越容易串）。
//
// 2) **block_idx 由我们编号后交给模型，模型只许引用已给的编号**。
//    让模型自己数第几块是必错的——它没有稳定的位置感。
//
// 3) **quote 必须逐字复制，8–60 字**。这是锚点能被机检的唯一前提。
//    允许它"概括一下"就等于放弃机检。
//
// 4) **允许 kind='absence'**。这是 v1 的核心出口：
//    "你缺对照组"这类质疑在原文里根本没有可引用的句子。
//    不给这个出口，模型唯一的出路是编一句假引用——而假引用会污染整个命中率。
//
// 5) **模型不输出 page / section**。这两个字段由服务端按 block_idx 回填。
//    让模型给页码，它会给一个"看起来合理"的页码，且没人能复核。
//
// 6) **risk 与 dimension 分开**：risk 是 1–5 的危险程度，dimension 是四个维度之一。
//    风险分最终由服务端从 claims 聚合（C13），模型只负责"这条有多危险"的初判。

import { z } from 'zod';
import { ClaimsOut } from '../schemas';
import type { Block } from '../parse';

export const CLAIMS_SYSTEM = `你是一位严格但公正的答辩评审。你的任务是**从给定材料片段中找出会被评委真正追问的点**，而不是夸赞作者。

【输出格式】
只输出一个 JSON 对象：{"claims": [ ... ]}，不要输出任何解释文字。

每个 claim 的字段：
- "type": "method" | "engineering" | "value"
    method      = 方法论层面（模型假设、对照组、统计检验、可复现性）
    engineering = 工程实现层面（性能、并发、错误处理、选型理由）
    value       = 价值与创新层面（解决了谁的什么问题、与现有方案差在哪）
- "text": 一句话说明"这里会被怎么追问"，4–120 字。要写成质疑句，不要写成评价句。
- "block_idx": 只能填我给你的编号（形如 [12]）。**不要自己数，不要编。**
- "kind": "quote" | "absence"
- "quote": **必须从该块原文里逐字复制连续的一段，8–60 字**。
   不许改写、不许补字、不许跨块拼接、不许把两句话拼起来。
   若这段原文里根本没有能支撑这条质疑的句子（例如"缺少对照组"这种缺失型判断），
   则 "kind" 填 "absence"，"quote" 留空，并在 "scope" 里写你查过的范围
   （章节名或"§3.2"这类编号，最长 60 字）。
- "risk": 1–5 的整数。5 = 一问就崩，1 = 无关痛痒。
- "dimension": "logic" | "evidence" | "depth" | "expression"

【硬性禁止】
- 不要输出 page、section 字段（服务端会回填）。
- 不要输出"建议""总结""总体评价"这类字段。
- 不要在 quote 里放省略号、方括号注释或"……"。
- 最多 12 条；少于 3 条也可以，宁可少而准，不要多而虚。

【判断标准】
只找**有实质内容可供追问**的点。赞美句、常识句、目录行、纯公式编号都不是质疑点。
若这批片段只是标题或目录，就返回 {"claims": []}。`;

/**
 * 把一批 block 编译成带编号的输入文本。
 *
 * 【注意】第二参数是 **block 编号（idx）的列表，不是数组下标**。
 * 这两者只有在 blocks 从 0 连续且一条都没被过滤时才相等——
 * `batchesOf` 会跳过短块，所以它们必然不等。
 * 早期版本用 `blocks[idx]` 按位置取，遇到过滤过的块就静默塞进空片段，
 * 模型只能凭空编 quote。所以这里显式按 `b.idx === idx` 查找。
 */
export function buildClaimsUser(blocks: Block[], batch: number[]): string {
  const byIdx = new Map(blocks.map((b) => [b.idx, b]));
  const lines: string[] = [];
  lines.push(`材料片段（块号 ${batch[0]}–${batch[batch.length - 1]}）：`);
  lines.push('');
  let shown = 0;
  for (const idx of batch) {
    const b = byIdx.get(idx);
    if (!b) continue; // 编号不存在就跳过，绝不拿别的块顶上
    const where = b.page !== null ? `P${b.page}` : b.section ?? '无章节';
    lines.push(`[${idx}] (${where}) ${b.text}`);
    lines.push('');
    shown++;
  }
  if (shown === 0) {
    // 一个都找不到时给模型明确信号，而不是让它对着空材料硬编
    return '（本批没有可用片段，请直接返回 {"claims": []}，不要编造内容。）';
  }
  lines.push('请按系统提示输出 JSON。注意 block_idx 必须是上面方括号里的数字。');
  return lines.join('\n');
}

/** 每批 5 块（L2 上下文分层的落点） */
export const BATCH_SIZE = 5;

/** 把 blocks 切成批次，跳过过短/过长的噪声块 */
export function batchesOf(blocks: Block[], size = BATCH_SIZE): number[][] {
  const usable = blocks
    .filter((b) => b.text.trim().length >= 12) // 太短的块（页码残留、单个标题）没有质疑价值
    .map((b) => b.idx);

  const out: number[][] = [];
  for (let i = 0; i < usable.length; i += size) {
    out.push(usable.slice(i, i + size));
  }
  return out;
}

export const ClaimsSchema = ClaimsOut;

export type ClaimsPromptV1 = {
  version: 'v1';
  system: string;
  batchSize: number;
};

export const CLAIMS_V1: ClaimsPromptV1 = {
  version: 'v1',
  system: CLAIMS_SYSTEM,
  batchSize: BATCH_SIZE,
};
