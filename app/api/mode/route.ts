// app/api/mode/route.ts —— 运行期切换「演示 / 真实」模式
//
// 【为什么需要这个端点】
// 用户要"随时从 demo 和真实样例切换"，且不重启服务。原来的模式是启动期
// 环境变量（MOCK_LLM）决定的，跑起来就改不了。这个端点把判定委托给
// lib/mode.ts 的运行期覆盖层，从而做到不重启切换。
//
// 【安全边界（评委安全网）】
// 切到 real 后：
//   · 上传页解除"只收内置样例"的硬拦（checkDemoOnly 据此解禁），可以传自己的材料；
//   · 评委发言改走真实模型（callReal），不再回放 fixture。
// 切回 mock 后两道闸自动恢复。所以"模式"是唯一总闸，切换它即同时切换两道约束。
//
// 【real 模式但没配密钥怎么办】
// 不在这里挡：调用方（callReal）在拿不到 DEEPSEEK_API_KEY 时会抛 E_NO_KEY，
// 前端已把这条错误翻译成"把 MOCK_LLM 设为 0 并配置模型密钥"的提示。
// 这里只负责切模式，不重复校验密钥 —— 切模式本身不是危险操作。

import { getMode, setMode, type AppMode } from '@/lib/mode';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ok: true, mode: getMode() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, code: 'E_BAD_JSON', message: '请求体不是合法 JSON。' }, { status: 400 });
  }

  const mode = (body as { mode?: unknown })?.mode;
  if (mode !== 'mock' && mode !== 'real') {
    return Response.json(
      { ok: false, code: 'E_MODE', message: 'mode 只能是 "mock"（演示/零 key 回放）或 "real"（真实模型）。' },
      { status: 400 },
    );
  }

  const changed = setMode(mode as AppMode);
  return Response.json({
    ok: true,
    mode: getMode(),
    changed,
    message:
      mode === 'mock'
        ? '已切换到演示模式：评委发言为录制回放，上传仅支持内置样例（零 key）。'
        : '已切换到真实模式：评委发言走实时模型，可上传你自己的材料（需配置 DEEPSEEK_API_KEY）。',
  });
}
