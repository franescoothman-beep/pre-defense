// app/api/docs/[id]/blocks/route.ts —— 读取一份材料的全部段落（原文侧栏用）
//
// 【为什么需要这条路由】
// 会话页的扫读区只拿得到 meta.source —— **当前这一块**的原文，
// 拿不到前一块、后一块。于是用户看到的"回到原文"永远只有一个片段，
// 没法判断"这句话在整篇里是什么位置、前后说了什么"。
// 侧栏要能上下滚动看前后文，就必须一次拿到全篇。
//
// 【为什么单独开一条，而不是塞进 GET /api/sessions/:id】
// 会话 GET 是轮询接口（每次换问都会刷）。全篇正文可能有几百 KB，
// 塞进去等于每次刷新都重传一遍。原文是**材料级**的、不随会话推进变化，
// 所以按 docId 单独取一次，缓存在页面 state 里。
//
// 【只读】不推进状态、不调模型、不写库。

import { loadBlocksOfDoc } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const blocks = loadBlocksOfDoc(id);
  return Response.json({
    ok: true,
    blocks: blocks.map((b) => ({
      idx: b.idx,
      page: b.page,
      section: b.section,
      text: b.text,
    })),
  });
}
