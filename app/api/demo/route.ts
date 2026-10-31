// app/api/demo/route.ts —— 演示模式用：给前端"一键进入内置样例"的入口
//
// 【为什么需要这个接口】
// 上传被禁用之后，用户不能干等着——必须有一条明确的下一步。
// 否则演示模式下的界面就是"什么都点不了"，比允许上传更糟。
//
// 它返回的是"已经解析好、且已抽过质疑点"的内置样例文档。
// 为什么挑"已抽过 claims 的"：只解析过是不够的，没有 claims 就进不了会话
// （POST /api/sessions 会报 E_NO_CLAIMS），用户会撞上第二个失败点。
//
// 【安全性】只返回内置样例（按文件名字段筛 sample-paper.docx），
// 不返回用户自己上传的材料 —— 否则演示模式仍可能把用户带到他自己的材料上。

import { q } from '@/lib/db';
import { isMockMode, DEMO_FILES } from '@/lib/demo';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isMockMode()) {
    return Response.json(
      { ok: false, code: 'E_NOT_MOCK', message: '这个接口只在演示模式下使用。' },
      { status: 404 },
    );
  }

  // 内置样例的展示名（fixtures/demo 里的文件名）
  const names = DEMO_FILES.map((f) => f);

  const rows = q.all(
    `select d.id, d.name, d.pages, d.chars, d.mode, d.density,
       (select count(*) from claims c where c.doc_id = d.id) as claims
     from documents d
     where d.name = ?
     order by d.created_at desc`,
    names[0],
  ).filter((r) => Number(r.claims) > 0);

  if (rows.length === 0) {
    return Response.json(
      {
        ok: false,
        code: 'E_NO_DEMO_DOC',
        message:
          '演示库中还没有可用的内置样例（需要先上传 sample-paper.docx 并抽取质疑点）。' +
          '请参考 README 的一键复现步骤。',
      },
      { status: 409 },
    );
  }

  const d = rows[0];
  return Response.json({
    ok: true,
    docId: String(d.id),
    name: String(d.name),
    pages: d.pages === null ? null : Number(d.pages),
    chars: Number(d.chars),
    mode: String(d.mode),
    density: String(d.density),
    claims: Number(d.claims),
  });
}
