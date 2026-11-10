# 2026-11-10 · 运行期「演示 / 真实」模式切换（功能冻结后解冻）

## 目标

让服务**不重启**即可在两种模式间切换：

| 档位 | 评委发言 | 上传 | 需要 key |
|---|---|---|---|
| 演示 · 零 key 回放 | `fixtures/llm/` 顺序回放 | 只收内置样例 | 否 |
| 真实 · 实时模型 | DeepSeek 实时生成 | 任意合法 PDF/DOCX | 是 |

动机来自用户提问（paraphrased）：「要不要说这是一个 demo 网站，或者设成可切换模式，随时从 demo 和真实样例切换」。
结论：作品是本地 Next.js 应用、不是"演示网站"，不该在文案上自贬；但原有实现只有**启动期** `MOCK_LLM`，
跑起来就改不了 —— 于是保留启动默认值不变，只加一层运行期覆盖。

## 冻结状态确认（动手前必读）

2026-11-10 是**功能冻结日**（`v1.0-freeze`，11-02 提前完成）。本次改动触碰 `lib/`、`app/api/`、
`components/`、`tests/` —— **属于解冻**，因此必须重走三项闸门。用户已明确选择"加运行时切换开关（解冻）"。

改动前的基线（同日早先已复验过 post-freeze 9 个 commit）：
- 单测 **416/416**
- fixture **39/39**
- build **18 路由**

## 改动

### 1. 新增 `lib/mode.ts` —— 模式判定唯一出口

```ts
export type AppMode = 'mock' | 'real';
function bootDefault(): AppMode { return process.env.MOCK_LLM === '1' ? 'mock' : 'real'; }
export function getMode(): AppMode { return g.__appMode ?? bootDefault(); }
export function isMockMode(): boolean { return getMode() === 'mock'; }
export function setMode(mode: AppMode): boolean { /* 幂等写 globalThis.__appMode */ }
export function resetMode(): void { /* 测试用，清覆盖回 env */ }
```

**为什么必须收敛到一个出口**：原来 `lib/llm.ts:144`、`lib/demo.ts:31`、`components/MockBadge.tsx:19`
各写一遍 `process.env.MOCK_LLM === '1'`。只要有一处没改，运行期切换就会出现
"界面显示真实模式、服务端仍在回放"（或反之）的错位 —— 那比不切换更危险。

**为什么挂 `globalThis` 而不落库**：与 `__db` / `__mockCursor` 同一套做法。Next 热重载会重新求值模块，
模块顶层变量会归零；挂 `globalThis` 才能让一次切换在整进程内稳定生效。
不落库的理由：模式是"这台服务当前怎么跑"的运行时事实，重启回到 `MOCK_LLM` 默认值即可，
不值得为演示开关引入表结构与迁移。

### 2. 三处判定改为委托

- `lib/llm.ts`：`isMock()` → `return isMockMode();`（import `isMockMode` from `./mode`）
- `lib/demo.ts`：`isMockMode()` → `return runtimeMockMode();`
- `components/MockBadge.tsx`：`isMockMode()` → `return runtimeMockMode();`

### 3. 新增 `app/api/mode/route.ts`

- `GET` **严格只读**，返回 `{ ok, mode }`（放在 GET 里改状态会让预取/爬虫意外切换模式）
- `POST { mode }`：只接受 `'mock' | 'real'`，否则 `400 { code: 'E_MODE' }`；成功返回生效后的 `mode` 与可读 `message`
- `export const dynamic = 'force-dynamic'`

不在这里校验 API key：切模式本身不危险，`callReal` 在缺 key 时抛 `E_NO_KEY`，文案已改成
"请在页面顶部切到「演示 · 零 key 回放」"。

### 4. `app/api/health/route.ts`

```ts
const mode = getMode();
return Response.json({ ok, tables, mode, mock: mode === 'mock' });
```

`mode` 供切换控件读当前档位；`mock` 保留给既有前端（上传页 `disabled={mockMode}`）向后兼容。

### 5. 新增 `components/ModeSwitch.tsx` + `.css`

- client 组件，`initialMode` **由服务端传入**（不在客户端拉 health 再渲染 —— 那会让控件先空一拍、失败时整条消失）
- 点击 → `POST /api/mode` → 成功则 `window.location.reload()`
- 整页刷新是刻意的：模式影响上传禁用态、报告页脚注、MockBadge，reload 能保证零幽灵状态；
  切换是低频操作，代价可接受
- CSS 全部走 `app/globals.css` token，**无十六进制颜色**（铁律 9）

### 6. `app/layout.tsx`

```tsx
export const dynamic = 'force-dynamic';   // 模式运行期可变，不能构建期静态化
const mode = getMode();
<MockBadge variant="header" />
<ModeSwitch initialMode={mode} />
```

### 7. `app/api/reports/[id]/route.ts`

`mock: process.env.MOCK_LLM === '1'` → `mock: isMockMode()`。
原写法在切到真实模式后仍会让报告页脚注谎称"录制回放"。

### 8. 文案同步（不改判定逻辑）

- `lib/demo.ts` `checkDemoOnly` 的 `E_MOCK_NOT_DEMO`：先提示"在页面顶部切到真实模式"，再给 `MOCK_LLM=0` 的兜底
- `lib/llm.ts` 两处 `E_NO_KEY`：先提示切档位
- `app/upload/page.tsx` 的 `mb-how`：同上

### 9. 测试

**改**（解冻范围内，断言跟随实现）：
- `tests/mock.test.ts`：原断言 `MockBadge.tsx` 含 `process.env.MOCK_LLM === '1'` →
  改为断言它委托 `runtimeMockMode`，并断言 env 检查仍存在于 `lib/mode.ts`
- `tests/demo.test.ts`：health 断言 `isMockMode()` →
  改为断言 `getMode` + `mock: mode === 'mock'` + 返回 `mode`；
  三个用 `process.env.MOCK_LLM` 驱动 `checkDemoOnly` 的用例补 `resetMode()`（**否则覆盖值会串给后面的用例**）

**新增** `tests/mode.test.ts`（9 条）：默认值来自 env、运行期覆盖优先、`setMode` 幂等、`resetMode` 复位、
`/api/mode` 取值校验与 GET 只读、health 双字段、layout 挂载、报告接口不残留 env 字面量。

**新增** `scripts/probe-mode-switch.mjs`：CDP 无头 Edge 真人点击探针，15 项断言。

## Bug 与修复过程

### ① `ModeSwitch.tsx` 写了两个 `'use client'` 指令

首次 `write` 时把注释块放在指令和第二个 `'use client'` 之间，产生重复指令（非法）。
`read` 确认后 `edit` 删除第二个。

### ② 模式切换控件不在 SSR HTML 里

首版 `ModeSwitch` 在 `useEffect` 里 `fetch('/api/health')` 拿模式。实测 `GET /` 的 HTML
**没有** `mode-switch`，只有 `mock-banner`：

```
  MISS  mode-switch
  HIT   mock-banner
```

两个问题：控件先空一拍；`next start` 下 `/` 若被静态预渲染，模式会冻结在构建期。
**修**：改为 `ModeSwitch({ initialMode })` 由 layout 传入，并给 layout 加 `dynamic = 'force-dynamic'`。
修后 SSR 断言全部命中，且切到 real 后 `mock-banner` 消失、切回 mock 恢复。

### ③ 探针"切不回去"（先失败 3 项）

首轮 `10/13`，失败项：切回 mock 档高亮、服务端 mode 已复位 mock、mock 角标恢复。

根因是**探针的时序 bug，不是产品 bug**：React 在 `fetch` 返回后先 `setMode(next)`（DOM 的 `on` class 立刻翻），
紧接着才 `window.location.reload()`。探针只盯着 class 变化就继续点击，此时按钮仍是 `disabled={busy}`，
第二次点击被丢掉。

**修**：`clickAndAwaitReload()` 改为等 CDP 的 `Page.loadEventFired`，并在点击前检查 `b.disabled`。
修后 **15/15**。

### ④ 第一次端到端上传验证测了个寂寞

用 `Buffer.from('not a demo sample at all')` 冒充 docx，real 与 mock 都返回
`400 E_MAGIC`（文件头校验），**在演示守卫之前就失败了**，什么也没证明。

**修**：改用「内置样例 + 追加字节」造一份哈希不同但结构合法的 docx。结果才有意义：
real → `200 + docId`；切 mock → `400 E_MOCK_NOT_DEMO`。

### ⑤ 3111 上的旧 dev 进程 500

`next build` 覆盖 `.next` 会杀死正在跑的 dev 服务（已知坑）。旧进程（PID 19832，16:35 启动）在
构建后返回 500。`Stop-Process` 清掉后重启，health 恢复 `ok:true`。

## 验收

| 闸门 | 结果 |
|---|---|
| 单测 | **425/425 pass, 0 fail**（原 416 + 新增 9） |
| fixture | **39 检查项 / 0 失败** |
| build | **✓ Compiled successfully，19 路由**（新增 `/api/mode`） |
| 零 key 闭环 | `verify-demo-loop.mjs` → **3 问 / 评委 3 位 / risk_score 81 / [OK]** |
| 浏览器走查 | `dry-run-shoot.mjs` → **23 张 / 65.2s / 5 问真人作答** |
| 模式切换探针 | `probe-mode-switch.mjs` → **15/15** |

端到端关键证据（同一份 docx，只切模式）：

```
REAL  upload mutated-docx -> 200 {"ok":true,"docId":"90a5a000-...","blocks":10,...}
MOCK  upload mutated-docx -> 400 {"ok":false,"code":"E_MOCK_NOT_DEMO", ...}
```

说明两道闸真的跟着模式走，不是 UI 假象。

单测末尾的 `[exit code: 1]` 是测试框架透传的非零退出码，判定依据是 `ℹ fail 0`（既有陷阱）。

## 契约偏离

- **解冻**：本次改动越过功能冻结线。已按解冻流程重跑三项闸门并全绿；`CLAUDE.md` 的"六条不可砍"
  一条未动（SSE、MOCK 回放、锚点溯源、quick 闭环、revise 闭环、prompt-eval 全部保持）。
- **`health` 响应新增 `mode` 字段**：纯增量，`mock` 保留，旧前端不受影响。
- **`app/layout.tsx` 改为动态渲染**：`/` 不再静态预渲染。代价是首页每次请求渲染一次（无 IO，可忽略），
  换来的是模式切换后角标不撒谎。

## 遗留问题

1. **模式覆盖不持久**：重启回到 `MOCK_LLM` 默认值。刻意如此（见上文取舍），但若评委在真实模式重启会回到演示。
2. **`scripts/demo.mjs` 仍硬编码 `MOCK_LLM: '1'`**：`npm run demo` 永远以演示模式启动，这是对的；
   但演示中若切到真实模式又重启，会静默回演示 —— README 已写明。
3. **`docs/recordings/dryrun-2026-11-10T08-46-43.md` 等产物未入库**：走查产物，按既有习惯不入库。
4. **正式录制仍未开始**，本次改动不影响录制口径，但录制前仍需按铁律：先跑 `verify-demo-loop.mjs`、
   开录前不许 build。

## commit

`feat(mode): 演示/真实运行期切换（单一模式出口 + /api/mode + 顶部切换条）`

- 新增：`lib/mode.ts`、`app/api/mode/route.ts`、`components/ModeSwitch.tsx`、`components/ModeSwitch.css`、
  `tests/mode.test.ts`、`scripts/probe-mode-switch.mjs`
- 修改：`lib/llm.ts`、`lib/demo.ts`、`components/MockBadge.tsx`、`app/layout.tsx`、
  `app/api/health/route.ts`、`app/api/reports/[id]/route.ts`、`app/upload/page.tsx`、
  `tests/mock.test.ts`、`tests/demo.test.ts`、`README.md`、`docs/technical-doc.md`
