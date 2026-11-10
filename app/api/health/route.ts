import { q } from '@/lib/db';
import { getMode } from '@/lib/mode';

export const dynamic = 'force-dynamic';

export async function GET() {
  q.init(); // 显式建连接：health 的职责就是证明「库真的开得起来」
  const tables = q.all("select name from sqlite_master where type='table' order by name");
  const mode = getMode();
  return Response.json({
    ok: true,
    tables: tables.map((t) => t.name),
    // 模式标记：前端上传页据此置灰并切换文案（服务端才是真正的拦截点）。
    // 它是"服务端事实"，不该让前端从 NEXT_PUBLIC 变量去猜 —— 猜错会让真实模式被误锁。
    // 运行期模式可被 /api/mode 切换，因此这里返回的是"当前生效模式"而非启动期 env。
    mode,
    mock: mode === 'mock',
  });
}
