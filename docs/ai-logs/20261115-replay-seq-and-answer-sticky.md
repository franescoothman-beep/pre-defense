# 2026-11-15 回放序号改由库推导 + 已答记录折叠 / 作答区钉底

## 目标

用户报了两件事（m02331）：

> 回答许教授的问题时，对话界面已经被占满了，而且这是许教授的问题吗？

拆成两个独立缺陷：

1. **题面错配**：屏幕上席位是许教授，问的却是陈评委那句评测集问题。
2. **现场断裂**：问题卡 + 扫读原文 + 判分卡串行排下来，作答框被挤出首屏，
   演示时"评委问完 → 我要先滚一整屏才够得着答题框"。

## Prompt 原文

> 回答许教授的问题时，对话界面已经被占满了，而且这是许教授的问题吗？

复核后我给两个根因和两个修法，用户批准（m02354）：

> 两个都修（推荐）

## 排查过程（先证伪，再定性）

### ① 席位与锚点是对的，只有题面文案错

直读 `data/app.db` 的 session `539746c6`：

| seq | kind | persona_id | target_claim_id | question | answer 长度 |
|---|---|---|---|---|---|
| 1 | question | 7077fce5（陈评委，已被删） | 49f7db76 | 这 800 条评测集… | 113 |
| 2 | followup | 7c91d4bb | 235eef4d | 这800条里有没有… | 92 |
| 3 | question | a5d85996（许教授，仍在） | 8aec927e | **与 seq1 完全相同** | 0 |

`a5d85996` 在 personas 表里就是许教授（engineering/depth），
`8aec927e` 是许教授名下的 claim（「检索片段与问题不相关或为空时怎么兜底」）。
**席位对、锚点对，只有 `turns.question` 这个文本字段回放错了。**

### ② 根因：mock 回放游标在进程内存里

`lib/llm.ts:375-376`：

```ts
const g = globalThis as unknown as { __mockCursor?: Map<string, number> };
const mockCursor = g.__mockCursor ?? (g.__mockCursor = new Map<string, number>());
```

`callMock` 与 `streamBody` 各自 `seq = mockCursor.get(key) ?? 0`。
挂 `globalThis` 是为了跨 Next 热重载存活，但**进程重启即归零**。

时间线完全吻合：第 1 问 17:09（旧进程）→ 我为验证改了代码、重启 demo → 19:16 第 2 问走新进程游标 0 → 取 `question.json` 第 0 条 = q1。

### ③ 反证：全新会话跑同一流程就不错

新会话上 Q1=陈评委/q1、Q2=许教授/q2。→ 缺陷不是"位置对齐错了"，只是"重启后序号归零"。

## 修法一：序号从库里推导

**为什么不把游标落盘（localStorage / DB 加一列）**：
库里已经有两个权威事实 —— 本场问过几问（`turns` 里 `kind='question'` 的条数）、
我答过几次（`answer` 非空的条数）。再存一份就是多一个会漂移的副本。

`lib/llm.ts` 新增：

```ts
replaySeq?: number;  // CallInput 字段

function takeSeq(input: CallInput): number {
  if (typeof input.replaySeq === 'number' && Number.isFinite(input.replaySeq)) {
    const forced = Math.max(0, Math.floor(input.replaySeq));
    mockCursor.set(`${input.sessionKey}:${input.phase}`, forced + 1);
    return forced;
  }
  const key = `${input.sessionKey}:${input.phase}`;
  const seq = mockCursor.get(key) ?? 0;
  mockCursor.set(key, seq + 1);
  return seq;
}
```

`callMock` 与 `streamBody` 两条回放路径都改成 `const seq = takeSeq(input);`
（原来各写一套游标读写）。

两个调用方：

- `app/api/sessions/[id]/stream/route.ts:329` → `replaySeq: round - 1,`
  （`round = mainsDoneOf(loadTurns(session.id)) + 1`，即本场第几问，0 起）
- `app/api/sessions/[id]/answer/route.ts:177` →
  `replaySeq: turnsBefore.filter((t) => String(t.answer ?? '') !== '').length,`
  （`turnsBefore` 是判分前取的，当前这一问 `answer` 还是空串，所以数出来的正好是"我前面答过几次"）

**evaluate 为什么用"已答条数"而不是"turns 总数"**：追问轮也要能对上 `evaluate.json` 的 a1..a5 顺序，而追问本身也是 turn（`kind='followup'`）。数"答过的"才对得上回放。

## 修法二：折叠 + 钉底

先量，再改。CDP 实测该会话（视口 1440×900）：

```
vh=900  docH=1473
.history  top=259   h=614   ← 只答过 2 轮
.turn     top=895   h=100
.scan     top=1009  h=136
.answer   top=1190  h=233   ← answerVisible = false
```

614px 是历史区自己的高度。五轮下来它一定超过一整个视口。

页面侧（`app/session/[id]/page.tsx`）：

- 新增 `openTurns: Set<string>` + `expandHistory: boolean`
- 每条渲染成 `<button className="hist-row" aria-expanded={open}>`：
  `第 N 问` + `追问` + 评委名 + `x / 5` + `+/−`
- 只有 `open` 时才渲染 `<div className="hist-body">`（问答正文 / 缺口 / 出处都收在里面）
- 顶部 `已答 N 条` + `全部展开 / 全部收起`

样式侧（`app/session/[id]/ask.css`）：

- `.hist-item` 从 `padding: 10px 0` 改为 `padding: 0`（否则折叠也不省高度）
- 新增 `.hist-bar` / `.hist-bar-label` / `.hist-toggle-all` / `.hist-row` / `.hist-row-score` / `.hist-caret` / `.hist-body`
- `.answer` 加 `position: sticky; bottom: 12px; z-index: 3;`

**为什么 sticky 不是 fixed**：fixed 脱离文档流、永久盖住正文底部（朗读原文时挡字）；sticky 只在父容器还没滚完时贴底，滚到底自然落回原位。

**为什么折叠头用 `<button>` 不用 `<div onClick>`**：键盘 Tab 能到、回车能展开。只读 div 会把这个能力变成鼠标专属。

## 规格测试

两个新文件（防以后被"优化"回去）：

`tests/replay-seq.test.ts`（5 条）

1. `CallInput` 必须声明 `replaySeq?: number`
2. `const seq = takeSeq(input);` 必须恰好出现 **2** 次（callMock + streamBody，不许各写一套游标）
3. `takeSeq` 必须识别 `replaySeq`，且把游标对齐到 `forced + 1`
4. stream 路由必须 `replaySeq: round - 1`，且 `round` 来自 `mainsDoneOf(loadTurns(...))`
5. answer 路由必须 `replaySeq: turnsBefore.filter(...).length`

`tests/session-layout.test.ts`（7 条）

1. `openTurns` 初值空集合、`expandHistory` 初值 false
2. `open = expandHistory || openTurns.has(h.turnId)`
3. 折叠头必须 `type="button"` 且带 `aria-expanded`
4. `hist-body` 必须挂在 `open` 条件里（折叠态不许留 DOM）
5. `.hist-item` 必须 `padding: 0`
6. `.hist-row` 必须 `width: 100%` + `cursor: pointer` + `border: 0`
7. `.answer` 必须 `position: sticky` + `bottom: 12px`，且**不许** `position: fixed`
8. 新增样式没引入动效，`border-radius` 全文件仍只 1 处

## Bug 与修复过程

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 第 2 问席位是许教授、题面却是陈评委的评测集问题 | `lib/llm.ts` 回放游标挂 `globalThis`，进程重启归零，`seq % all.length` 又取回第 0 条 | 序号改由调用方从库里推导（`replaySeq`），游标只做同进程兜底 |
| 2 | 作答框 top=1190 在 900 视口之外 | 已答记录全量展开（只 2 轮就 614px）+ 作答区在流末 | 历史默认折叠成单行、作答区 `position: sticky; bottom: 12px` |
| 3 | `.hist-item` 改了折叠但 `padding: 10px 0` 还在 | 只改 JSX 没改样式，折叠省的只是正文高度 | `.hist-item { padding: 0 }`，并加断言钉住 |
| 4 | probe 首次运行 `require is not defined`（ESM 文件里用了 `require`） | 顶层是 ESM，`require` 不存在 | 改成 `const { existsSync } = await import('node:fs')` |

## 门禁

| 项 | 结果 |
|---|---|
| `npm test` | **455 pass / 0 fail**（443 → +5 replay-seq → +7 session-layout） |
| `npm run test:fixtures` | 51 项 / 0 失败 |
| `npm run build` | 成功 20 路由，`/session/[id]` 6.62 kB、First Load JS 109 kB |
| `verify-demo-loop`（BASE=3111） | `[OK]`：3 问 / 3 位评委 / material_risk 4 维 / performance 4 维 / 高风险 8 / risk_score 75 / history 5 条且每条都有回答原文 + gaps + locators |
| `probe-orig-sidebar` | `[OK]`：点段定位、评委位置不被改、可一键回到当前块 |
| `probe-answer-first-screen`（新） | `[OK]`：判据 1 默认折叠 2 条 / 判据 2 作答框 top=655 h=233 视口 900 **在首屏内** / 判据 3 单条展开收起 / 判据 4 全部展开 |
| `probe-mobile` 400px | `clientW=400 scrollW=400` 无横向溢出 |
| `probe-replay-seq`（新，两阶段） | phase1 建会话答完 Q1 → **kill 服务并重启** → phase2 取下一问 = 许教授「检索片段为空时怎么兜底」**≠ q1** → `[OK]` |

修前 / 修后对比（答完第 1 问 + 追问的现场）：

| | 修前 | 修后 |
|---|---|---|
| `.history` 高度 | 614px | 折叠后约 88px |
| `.answer` 顶边 | 1190px（屏外） | 655px（屏内，且 sticky 钉底） |
| 第 2 问（重启后） | 又出现 q1 | q2，席位许教授 |

## 环境坑

`npm run build` 覆盖 `.next` → 仍在跑的 dev server 报 `Cannot find module './887.js'`，
`/api/demo` 500，`verify-demo-loop` 报 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`。

**顺序必须是：build → kill 旧 demo 作业 → 重起 demo → 再跑探针。**
kill 后立刻重起会撞 `Error: listen EADDRINUSE: address already in use :::3111`，需先等 3～4 秒。

## 遗留

1. `app/api/sessions/route.ts:204` 建新会话时 `delete from personas where doc_id = ?`，
   会让**旧会话**的 `persona_id` 变成悬空外键，报告页署名显示「评委」。
   这是本轮顺带发现的（session 539746c6 的 seq1/seq2 已中招），未修 —— 改动会碰报告页取人设的口径，需要单独确认。
2. 折叠态只保留"第几问 / 谁问的 / 多少分"，不含问题摘要。
   若录制时导演嫌信息不够，可在折叠头加一句 12 字截断的问题摘要（会多占约 20px/条）。
3. `.answer` 的 `z-index: 3` 是为了压住扫读光带（`z-index: 1`）与侧栏（默认流内）。
   若后续新增同层浮层，需要重新排这个数。

## commit

`fix(session): 回放序号改由库推导 + 已答记录折叠、作答区钉底`
