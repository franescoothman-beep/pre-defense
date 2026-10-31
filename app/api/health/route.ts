import { q } from '@/lib/db';
import { isMockMode } from '@/lib/demo';

export const dynamic = 'force-dynamic';

export async function GET() {
  q.init(); // 显式建连接：health 的职责就是证明「库真的开得起来」
  const tables = q.all("select name from sqlite_master where type='table' order by name");
  return Response.json({
    ok: true,
    tables: tables.map((t) => t.name),
    // mock 标记：前端上传页据此置灰（服务端才是真正的拦截点）。
    // 它是"服务端事实"，不该让前端从 NEXT_PUBLIC 变量去猜 —— 猜错会让真实模式被误锁。
    mock: isMockMode(),
  });
}
