import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  q.init(); // 显式建连接：health 的职责就是证明「库真的开得起来」
  const tables = q.all("select name from sqlite_master where type='table' order by name");
  return Response.json({ ok: true, tables: tables.map((t) => t.name) });
}
