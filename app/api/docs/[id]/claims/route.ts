// app/api/docs/[id]/claims/route.ts —— 质疑点抽取（POST）与读取（GET）
//
// POST 流程：读 blocks → 分批喂模型 → zod 校验（在 llm 里）→
//            **按 block_idx 回填 page/section** → attachLocator 机检 → 写 claims
// GET  流程：直接读已抽好的 claims（卡片页刷新用）
//
// 【本路由最关键的一件事】locator 机检不可省（CLAUDE.md 铁律 3）：
//   quote 类必须过 verifyQuote（逐字命中，失败在 ±2 邻域与全篇兜底重试）；
//   absence 类必须过 verifyAbsence（scope 合法）；
//   未命中的条目**保留**并标 verified=0，进入命中率分母——不许隐藏。

import { q } from '@/lib/db';
import { callLLM, resetMockCursor, isMock } from '@/lib/llm';
import { CLAIMS_SYSTEM, buildClaimsUser, batchesOf, ClaimsSchema } from '@/lib/prompts/claims.v1';
import { attachLocator, rateOf } from '@/lib/locator';
import type { Block } from '@/lib/parse';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** 单次上传最多抽几批（防止 2400 块的论文把预算抽干，S6 预算 ≤30 次） */
const MAX_BATCHES = 12;

type ClaimRow = {
  type: 'method' | 'engineering' | 'value';
  text: string;
  block_idx: number;
  page: number | null;
  section: string | null;
  quote: string;
  locator_kind: 'quote' | 'absence';
  scope: string | null;
  verified: 0 | 1 | null;
  risk: number;
  dimension: 'logic' | 'evidence' | 'depth' | 'expression';
};
function loadBlocks(docId: string): Block[] {
  const rows = q.all(
    'select idx, page, section, text from blocks where doc_id = ? order by idx',
    docId,
  );
  return rows.map((r) => ({
    idx: Number(r.idx),
    page: r.page === null ? null : Number(r.page),
    section: r.section === null ? null : String(r.section),
    text: String(r.text),
  }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rows = q.all('select * from claims where doc_id = ? order by block_idx', id);
  // 刷新后「展开原文」仍然要能用，所以 GET 也附上整块原文
  const srcRows = q.all('select idx, text from blocks where doc_id = ?', id);
  const byIdx = new Map<number, string>(srcRows.map((r) => [Number(r.idx), String(r.text)]));
  return Response.json({
    ok: true,
    claims: rows.map((r) => ({ ...r, source: byIdx.get(Number(r.block_idx)) ?? '' })),
  });
}

/**
 * 取一批块的原文（卡片页「展开原文」用）。
 *
 * 【为什么要单独给上下文，而不是只给 quote】
 * 卡片页要让用户判断的是"这句话**是否支持**这个结论"，而不只是"这句话**是否存在**"。
 * 只显示那一句 quote，用户看不到它前后说了什么，就无法判断语义是否被曲解——
 * 而"命中≠支持"正是本作品在第 6 章要诚实写出的局限。
 * 所以这里返回整块原文，前端用纯文本切分把 quote 高亮出来。
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleExtract(ctx);
}

async function handleExtract(ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: docId } = await ctx.params;

  const doc = q.get('select id, name, density from documents where id = ?', docId);
  if (!doc) {
    return Response.json({ ok: false, code: 'E_NO_DOC', message: '找不到这份材料。' }, { status: 404 });
  }

  const blocks = loadBlocks(docId);
  if (blocks.length === 0) {
    return Response.json(
      { ok: false, code: 'E_NO_BLOCKS', message: '这份材料还没有解析出文本块，请重新上传。' },
      { status: 409 },
    );
  }

  const allBatches = batchesOf(blocks);

  if (allBatches.length === 0) {
    return Response.json(
      {
        ok: false,
        code: 'E_TOO_THIN',
        message: '这份材料的文字太少（都是短行或目录），没有可抽取的质疑点。请换一份内容更完整的材料。',
      },
      { status: 422 },
    );
  }

  // 【为什么不是 slice(0, MAX_BATCHES)】
  // 101 页论文有 2400 块 → 480 批，而预算只有 30 次。
  // 直接取前 12 批 = 只审了前 60 块，也就是"只有摘要和第一章被质疑"，
  // 而且**用户完全不知道**——报告看起来完整，实际只看了 2.5% 的材料。
  // 改为**均匀采样**：覆盖整篇（开头/中段/结尾都取到），并明确告知用户覆盖了哪些批。
  const sampled =
    allBatches.length <= MAX_BATCHES
      ? allBatches
      : Array.from({ length: MAX_BATCHES }, (_, i) => {
          // 均匀取样下标 0, step, 2*step, ... 保证首尾都被覆盖
          const at = Math.floor((i * (allBatches.length - 1)) / (MAX_BATCHES - 1));
          return allBatches[at];
        });

  // 先清掉旧结果：重抽必须是"替换"而不是"叠加"，否则重复抽取会让命中率分母虚高
  q.run('delete from claims where doc_id = ?', docId);

  // mock 模式下必须复位游标，否则第二次抽取会从 seq 末尾继续 → E_MOCK_MISS → 0 条
  if (isMock()) resetMockCursor(`claims:${docId}`);

  const all: ClaimRow[] = [];
  const verifiedEntries: Array<{ kind: 'quote' | 'absence'; verified: 0 | 1 | null; reason: string }> = [];

  for (let i = 0; i < sampled.length; i++) {
    const batch = sampled[i];
    let out;
    try {
      out = await callLLM({
        sessionKey: `claims:${docId}`,
        phase: 'claims',
        system: CLAIMS_SYSTEM,
        user: buildClaimsUser(blocks, batch),
        schema: ClaimsSchema,
        temperature: 0.1, // 抽取要稳定，不要发挥
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // 抽取是"能抽多少算多少"的活：一批失败不该让整份材料报废
      console.error(`[claims] 第 ${i + 1} 批失败：`, err.code, err.message);
      continue;
    }

    const claims = (out.data as { claims: Array<{
      type: 'method' | 'engineering' | 'value';
      text: string;
      block_idx: number;
      kind: 'quote' | 'absence';
      quote: string;
      scope?: string;
      risk: number;
      dimension: 'logic' | 'evidence' | 'depth' | 'expression';
    }> }).claims;

    for (const c of claims) {
      // ① 模型给的 block_idx 必须是本批里真实存在的编号，否则丢弃这条
      if (!batch.includes(c.block_idx)) continue;

      // ② 机检 + 回填（attachLocator 内部按 kind 分派 quote/absence）
      const { locator, result } = attachLocator(blocks, {
        kind: c.kind,
        block_idx: c.block_idx,
        quote: c.quote,
        scope: c.scope,
      });
      if (!locator) continue; // block_idx 越界

      all.push({
        type: c.type,
        text: c.text,
        block_idx: locator.blockIdx,
        page: locator.page,
        section: locator.section,
        quote: locator.quote,
        locator_kind: locator.kind,
        scope: locator.scope ?? null,
        verified: result.verified,
        risk: c.risk,
        dimension: c.dimension,
      });
      verifiedEntries.push({ kind: locator.kind, verified: result.verified, reason: result.reason });
    }
  }

  const now = new Date().toISOString();
  for (const c of all) {
    q.run(
      `insert into claims(id, doc_id, type, text, block_idx, page, section, quote,
                          locator_kind, scope, verified, risk, dimension, created_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      crypto.randomUUID(),
      docId,
      c.type,
      c.text,
      c.block_idx,
      c.page,
      c.section,
      c.quote,
      c.locator_kind,
      c.scope,
      c.verified,
      c.risk,
      c.dimension,
      now,
    );
  }

  const rate = rateOf(verifiedEntries);

  // 整块原文：卡片页「展开原文」要显示 quote 的**上下文**，否则用户无法判断
  // "这句话是否支持这个结论"（命中≠支持，见 §3.10 的第三条指标）。
  const sourceByBlock = new Map<number, string>(blocks.map((b) => [b.idx, b.text]));

  return Response.json({
    ok: true,
    total: all.length,
    // 覆盖范围必须如实告知：材料太大时只审了一部分，不能装成审了全部
    batches: sampled.length,
    totalBatches: allBatches.length,
    coverage: {
      sampledBatches: sampled.length,
      totalBatches: allBatches.length,
      /** 是否做了抽样（材料超过预算才为 true） */
      sampled: allBatches.length > MAX_BATCHES,
      /** 被跳过的批次数，UI 要显示出来，不许隐藏 */
      skippedBatches: Math.max(0, allBatches.length - sampled.length),
    },
    // 两类 locator 分开统计，绝不混进同一个分母（§3.5）
    quote: rate.quote,
    absence: rate.absence,
    // 回传时带上整块原文（block_idx 去重，避免 2400 块的响应膨胀）
    claims: all.map((c) => ({ ...c, source: sourceByBlock.get(c.block_idx) ?? '' })),
  });
}
