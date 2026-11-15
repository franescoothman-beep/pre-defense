# 2026-11-15 重抽后席位塌成 1 位 + 答完看不见自己的回答

## 目标

录制前用户真机点了一整场，报了三件事：

1. 「怎么回答一问就结束了」—— 会话只有 1 位评委、总共 1 问
2. 「自己回答了什么发送后也看不到」—— 提交后回答正文从界面上消失
3. 「回到原文这个功能，我只能看到一个片段」—— 扫读区只有一段原文

本轮修 ① 和 ②（③ 撞功能冻结线 2026-11-10，等用户单独确认）。

## Prompt 原文（摘要）

- 「怎么回答一问就结束了」「自己回答了什么发送后也看不到」「回到原文这个功能，我只能看到一个片段，单独给一个窗口在旁边跳转是不是更好」
- 「需要」（批准 P0 + P1 一起做）
- 「现在去掉重复的判分面板，让历史记录成为唯一的问答时间线」

## AI 输出摘要

### 1. 一问就结束 = 重抽把维度分布改了，席位序漂了

DB 时间线是决定性证据：

```
claims 全部 17 条 created_at = 2026-11-15T07:31:47.442Z   ← 同一时刻 = 一次重抽
session 1630a163 started_at = 2026-11-15T07:31:49.224Z    ← 两秒后开场
```

用户在质疑点页点了「重新抽取」，然后才开场。重抽走 `fixtures/llm/claims.json` 回放，把 2 条 claim 判成 `logic/method`（`081dd30c-d3d1-4d47-b088-65a48d6621c3`、`e038d24a-b948-4c31-9c79-46d20241afbc`），分布从种子的 `evidence 7 / depth 6 / logic 4` 变成 `evidence 7 / logic 6 / depth 4`。

`lib/prompts/personas.v1.ts` 的 `planSeats` 按 `(dimension,type)` 计数排席位、**维度按条数降序**：

```
种子：  [evidence·method, depth·engineering, logic·value]  = 陈 / 许 / 周  （录制序）
漂移后：[evidence·method, logic·value,     depth·engineering]
```

而 `app/api/sessions/route.ts:166-173` 是**按下标**对齐的：

```ts
const validated = personasOut.slice(0, seats.length).map((p, i) => {
  const allowed = seatClaimIds(seats[i]);
  const openings = p.opening.filter((o) => allowed.has(o.claim_id) && claimById.has(o.claim_id));
  return { ...p, seat: seats[i], opening: openings };
}).filter((p) => p.opening.length > 0);
```

许/周的 `opening[].claim_id` 落不进自己第 i 席的候选 → `opening` 空 → 被 `filter` 丢掉 → `validated.length = 1` → `progressOf` 算出 `qTotal = personaCount * mainsEach = 1 * 1 = 1` → **座位 1/1、第 1/1 问**。

**为什么 11-15 早上那版修复没拦住**：`syncClaimDimTypes` 只在 `scripts/demo.mjs` 启动时跑。服务已经跑起来之后用户点重抽，那条路径完全绕过了它。

### 2. 修法：对齐逻辑下沉到 `lib/seed-sync.ts`，重抽路由自己调

新建 `lib/seed-sync.ts`（131 行），导出 `demoSeed()` / `isDemoDoc()` / `diffDemoClaimDims()` / `syncDemoClaimDims()`：

- 判「是不是内置样例」用**内容指纹**（`documents.content_hash` 比对），因为 docId 每次上传都变，只有文件字节哈希稳定；也接受 docId 直接等于种子 id。
- `syncDemoClaimDims` 只在同一事务里 `update claims set dimension = ?, type = ? where id = ?` —— **不动 `block_idx` / `quote` / `risk` / `verified`**（那是锚点，动了溯源就废），不删不插。
- 失败回滚并 `console.warn`，返回 `-1`；不是内置样例返回 `0`（真实模式上传自己的材料，一行都不碰）。

两个调用点共用同一份实现：

- `scripts/demo.mjs`：删掉原来的内联实现，改成薄封装 `return syncDemoClaimDims(docId)`，开机对齐。
- `app/api/docs/[id]/claims/route.ts:237`：`const dimSynced = isMock() ? syncDemoClaimDims(docId) : 0;`，**重抽落库之后、`rateOf()` 之前**调用，命中时打 warn。

为什么是「修维度分布」而不是「改对齐方式」：只把对齐改成按内容匹配，3 位评委确实都能留下，但**上场顺序会变成 陈/周/许**，而问题文本是 `question.json` 按序号回放的（q1→q2→q3），一错位就变成「周评委在问兜底、许教授在问推广」，画面照样是错的。

### 3. 答完看不见自己的回答 = 真缺陷，不是观感问题

两处原因：

- `app/session/[id]/page.tsx` 提交成功后 `setAnswer('')`，判分面板只渲染分数/缺口/出处，**回答正文再没有任何地方渲染**。
- `GET /api/sessions/[id]` 响应键只有 `ok, sessionId, docName, state, mode, modeLabel, personas, progress, currentPersonaId, pastPersonaIds` —— **不返回 turns**，刷新即丢。

修法两层：

**服务端** `app/api/sessions/[id]/route.ts`（73 → 144 行）：新增 `history: turns.map((t) => toHistoryItem(t, personaById))`。`toHistoryItem` 里：

- `gaps` / `locators` 从库里存的 JSON 字符串解析回数组，用宽容解析 `parseJsonArray<T>(raw: string|null): T[]`（坏 JSON 给 `[]`，不让一条脏数据把整页打挂）；
- `anchor` 走 `loadAnchor(t.targetClaimId)`，拆成 `claimId / blockIdx / page / section / quote / locatorKind / verified`；
- `personaName` / `personaDimension` 从 `personaById` 查，查不到就是 `null`，**不编名字**。

**客户端** `app/session/[id]/page.tsx`（675 → 898 行）：

- 新增 `HistoryItem` 类型与 `<section className="history">`，逐条渲染「第 N 问 / 追问 / 评委名 / 问题 / 我的回答 / 分数 / 缺口 / 出处」；
- `submit()` 在**发请求之前**就把 `answeredTurnId / answeredText / answeredQuestion / answeredMeta` 取成快照 —— 因为三条分支都会 `setAnswer('')` / `setDoneInfo(null)` / `setMeta(追问)`，进了分支再取就只剩追问的内容；
- 判分面板加 `.verdict-answer` 显示「我的回答」；
- 两者不重复：`history` 合并时 `.filter((h) => h.turnId !== verdictTurnId)`，刚答完那一问由判分面板显示，下一问开始时 `setVerdictTurnId(null)` 让它并进时间线。

用户中途的指令「去掉重复的判分面板，让历史记录成为唯一的问答时间线」落成了上面这个 `verdictTurnId` 排他规则。

### 4. 把「回答必须留得住」变成判据，而不是靠人看

`scripts/verify-demo-loop.mjs` 追加两段：

- 答一次 `answered++`；
- 出报告后 `GET /api/sessions/:id`，断方 `history.length === answered`、每条 `answer` 非空、`gaps`/`locators` 是数组。

新增 `scripts/probe-answer-visible.mjs`：CDP 起无头 Edge，**真点一次**「提交并判分」，断方页面上还能读到回答里那句「800 条全部参与了多轮调优」。必须真点，因为回答能不能看见是客户端 state 与渲染的产物 —— API 层答对了不等于页面答对了。

## Bug 与修复过程

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 座位 1/1、第 1/1 问 | 重抽把 2 条 claim 的 dimension 从 depth 改成 logic → `planSeats` 席位序漂 → 按下标对齐后 2 位评委 opening 全落空 | `syncDemoClaimDims` 下沉到 `lib/seed-sync.ts`，重抽路由自己调 |
| 2 | 开机对齐拦不住运行期重抽 | `syncClaimDimTypes` 只在 `demo.mjs` 启动时执行 | 同上，重抽路径也调 |
| 3 | 提交后回答消失 | `setAnswer('')` 后无处渲染；GET 不返回 turns | 判分面板带回答快照 + `history` 时间线 |
| 4 | 同一问答渲染两遍 | 判分面板与 history 同时显示刚答完那一问 | `verdictTurnId` 排他过滤 |
| 5 | 探针第一版误报 FAIL | 断言只认 `.verdict-answer-text`，而答追问时页面已前进到下一问、原问答进 history | 断言改成「页面上还能读到那句原话」，两条落点都认 |
| 6 | `verify-demo-loop` 报 `Unexpected token '<'` | `npm run build` 覆盖了 `.next`，还在跑的 dev server 模块丢失（`Cannot find module './887.js'`） | 重启 demo 服务后重跑 |
| 7 | `verify-demo-loop` 默认打 3000 端口 | 脚本 `BASE` 默认 `http://127.0.0.1:3000` | 一律 `$env:BASE='http://127.0.0.1:3111'` 再跑 |

## 门禁

- `npm test` **430 / 430**，fail 0
- `npm run test:fixtures` **51 项 / 0 失败**
- `npm run build` 成功，**19 条路由**，`/session/[id]` 5.49 kB
- `verify-demo-loop`（BASE=3111）`[OK]`：3 问 / 评委 3 位 / material_risk 4 维 / performance 4 维 / 高风险 8 / `risk_score 75` / `[history] 5 条（答题 5 次）` 每条都有回答原文 + gaps + locators
- `probe-answer-visible`（BASE=3111）`[OK]`：提交后 `.verdict-answer-text` 里仍有回答原文
- 重抽回归实测：`POST /api/docs/{id}/claims` → 17 条、quote 15/15、absence 2/2 → `diag-seats` `validated.length = 3` → 新建会话 `personas 3（陈/许/周）`
- `probe-mobile` 400px：`/session/{id}` 无横向溢出（clientW 400 / scrollW 400）

## 遗留

- P2「右侧原文侧栏」未做：扫读区仍只渲染 `meta.source` 单 block。数据够做（`claims.block_idx` + `blocks` 全文 + `app/doc/[id]/page.tsx` 已有 `splitByQuote` / `Highlighted`），但撞功能冻结线，等用户单独确认。
- `data/app.db` 里堆着历次探针留下的未答 turn，不影响新建会话（`loadTurns` 按 `session_id` 隔离），但会让手写探针读错。
- `scripts/diag-seats.mjs` / `diag-seed-file.mjs` / `resync-seed-dims.mjs` / `check-followups.mjs` / `probe-answer-visible.mjs` 保留为长期工具；本轮 8 个 `tmp-*.mjs` 已全部删除。
