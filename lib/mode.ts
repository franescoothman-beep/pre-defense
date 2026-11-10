// lib/mode.ts —— 运行期「演示 / 真实」模式判定与切换（唯一的模式出口）
//
// 【为什么新增这一层，而不是直接读 process.env.MOCK_LLM】
// 原来的判定散落在 lib/llm.ts（isMock）、lib/demo.ts（isMockMode）、
// components/MockBadge.tsx（isMockMode）三处，各自写 `process.env.MOCK_LLM === '1'`，
// 都是读启动期环境变量 —— 一旦服务跑起来就改不了，必须重启才能切。
// 用户要的是「随时从 demo 和真实样例切换」，且不能重启，所以需要一个
// 运行期可覆盖、但启动默认值仍由环境变量决定的单一出口。
//
// 【启动默认值仍然来自 env】
// `npm run demo`（MOCK_LLM=1）启动 → 默认 mock；
// 普通 `npm run dev`（不设 MOCK_LLM）启动 → 默认 real。
// 这与原来的行为完全一致，只是多了一个"运行期可被覆盖"的层。
//
// 【运行期覆盖存在哪】
// 挂在 globalThis（与 lib/db.ts 的 __db、lib/llm.ts 的 __mockCursor 同理），
// 这样在 Next 热重载 / 多 worker 重新求值模块时不会归零，一次切换全进程生效。
// 不落库：模式是"这台服务当前怎么跑"的运行时事实，重启后回到 env 默认值即可，
// 不需要持久化（且避免 schema 迁移）。
//
// 【评委安全网不受影响】
// 演示模式的两个硬约束 —— ① 上传只收内置样例（checkDemoOnly）、② 评委发言走回放不走真模型
// （callMock vs callReal）—— 都从这里取判定。切换成 real 后这两处自动解禁，
// 切回 mock 后自动恢复。也就是说"模式"这个开关是唯一的总闸，切换它就等于同时切换两道闸。

export type AppMode = 'mock' | 'real';

const g = globalThis as unknown as { __appMode?: AppMode };

/** 启动默认值：MOCK_LLM=1 → mock，否则 → real */
function bootDefault(): AppMode {
  return process.env.MOCK_LLM === '1' ? 'mock' : 'real';
}

/** 当前生效模式：运行期覆盖优先，否则取 env 默认值 */
export function getMode(): AppMode {
  return g.__appMode ?? bootDefault();
}

/** 是否为演示（MOCK）模式 */
export function isMockMode(): boolean {
  return getMode() === 'mock';
}

/**
 * 运行期切换模式。
 *
 * 返回是否真的发生了切换（相同值视为幂等，返回 false）。
 * 校验交给路由层（只允许 'mock' | 'real'），这里只负责写入。
 */
export function setMode(mode: AppMode): boolean {
  const next = mode === 'mock' ? 'mock' : 'real';
  if (g.__appMode === next) return false;
  g.__appMode = next;
  return true;
}

/** 测试用：清掉运行期覆盖，回到 env 默认 */
export function resetMode(): void {
  delete g.__appMode;
}
