import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const tables = q.all("select name from sqlite_master where type='table' order by name");
  return Response.json({ ok: true, tables: tables.map((t) => t.name) });
}
