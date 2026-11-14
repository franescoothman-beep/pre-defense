# 2026-11-14 · 看板加长 + 修「质询不了了」（锚点 id 漂移根治）

## 目标

用户原话：

> 这三个看板拉长一点吧感觉太小了，而且为什么我质询不了了

配图是质疑点页：顶部红框 `E_START` ——「生成的评委会问题没能对上任何一条属于自己的质疑点（锚点归属校验失败）。请重试一次。」

两件事：① 三列看板太矮，要更长；② 质询点了没反应，必须修好。

## Prompt 原文

> 这三个看板拉长一点吧感觉太小了，而且为什么我质询不了了

## 一、先定位「质询不了了」

### 复现

```bash
POST http://127.0.0.1:3111/api/sessions
{"docId":"07b4f607-5393-4617-82b4-a5ea67e605dc","mode":"quick"}
→ 502 {"ok":false,"code":"E_NO_ANCHOR",
   "message":"生成的评委会问题没能对上任何一条属于自己的质疑点（锚点归属校验失败）。请重试一次。"}
```

### 根因链

`app/api/sessions/route.ts:170` 的锚点归属校验把回放的评委问题按 `claim_id` 过滤：

```ts
const openings = p.opening.filter((o) => allowed.has(o.claim_id) && claimById.has(o.claim_id));
```

过滤后 `validated.length === 0`（第 182 行）→ 502 `E_NO_ANCHOR`。

而 `fixtures/llm/personas.json` 里三位评委的 opening 是**硬编码 claim_id** 的（`235eef4d…` / `49f7db76…` / `8aec927e…` / `67822d40…` / `87dcfe42…` / `5b4c4413…`，正是 `scripts/seed-demo-data.json` 那 17 条里的 6 条）。

**但库里那 17 条 claim 的 id 全变了**（`created_at` 全是 `2026-11-14T05:35:02.365Z`，比 doc 创建 `04:46:55` 晚 48 分钟）—— 用户在质疑点页点过一次「重新抽取」。

`app/api/docs/[id]/claims/route.ts` 的重抽逻辑当时是：

```ts
q.run('delete from claims where doc_id = ?', docId);   // 全删
...
q.run(`insert into claims(...) values(?,?...`, crypto.randomUUID(), ...);  // 全换新 id
```

⇒ 一次「重新抽取」就把所有人 claim id 换成新 UUID，personas fixture 的引用全部脱钩。**这就是"我质询不了了"的完整答案。**

### 为什么长期没被发现

`scripts/test-fixtures.mjs` 只有三层校验：结构（zod）／机检（locator 逐字命中）／跨条（personas 三位 opening 的 claim_id 互不相同）。**从没读过 `scripts/seed-demo-data.json`**，所以 fixture 与种子的 claim_id 脱钩它一律看不见，一直是绿的。

这不是第一次：`docs/ai-logs/20261103-dry-run-shoot.md:108` 记着「修法：按 `seed-demo-data.json` 的 12 条原 id 重插」—— 11-03 就踩过一次，这次复发。

### 三层修复

**① 重抽复用旧 id（根治）** —— `app/api/docs/[id]/claims/route.ts`

在 `delete` 之前先把旧锚点建成索引，insert 时按「同锚点 = 同 id」复用：

```ts
const prevIds = new Map<string, string>();
for (const r of q.all(
  'select id, block_idx, quote, locator_kind from claims where doc_id = ?',
  docId,
) as Array<{ id: string; block_idx: number; quote: string; locator_kind: string }>) {
  prevIds.set(`${r.block_idx}|${r.locator_kind}|${r.quote}`, r.id);
}
...
const anchorKey = `${c.block_idx}|${c.locator_kind}|${c.quote}`;
const id = prevIds.get(anchorKey) ?? crypto.randomUUID();
```

`block_idx + locator_kind + quote` 三者相同即视为同一个锚点。重抽只更新 `text/risk/dimension` 这些可再判的字段，锚点的"身份证"不动。

**② demo 启动自愈** —— `scripts/demo.mjs`

`seedIfMissing()` 原来只判断「这条路有没有 claims」，有就跳过。改成：读库里的 id 集合，与种子的 17 条比对；一条不缺才跳过，缺了就按种子原样重插并打印

```
[demo] 检测到锚点 id 漂移（种子 17 条里有 17 条已不在库里），按种子修复 claims。
[demo] 已按种子修复 17 条 claims，personas 回放重新接得上。
```

**③ 补第 4 层校验** —— `scripts/test-fixtures.mjs`

新增「锚点层」：扫全部 fixture 里的 36 位 UUID（排除 `seed.doc.id` 这个 docId），任何一个不在种子 claim id 集合里就 `fail`。

```
检查项：51 · 失败：0
✓ 全部回放剧本与当前 schema、机检规则一致。
```

负向对照已做：往 `personas.json` 注入 `deadbeef-0000-4000-8000-000000000000` 后立刻红：

```
✖ fixtures/llm/personas.json：1 个 claim_id 不在 demo 种子里（deadbeef）
  —— 演示时这些引用会被静默丢弃，personas 更会直接 502
```

### 顺手修掉的 5 个失效引用

锚点层一上来就抓到 5 条（evaluate 1 条 + report 4 条），都是同一批脱钩遗留。按语义映射回种子里最贴的那条：

| 失效 id | 出现在 | 映射到 | 依据 |
|---|---|---|---|
| `36499b57` | evaluate seq[2]/seq[3]、report high[3] | `e038d24a` | 「无基线对照」那条（"检索增强路线的有效性"） |
| `2c9b1ddb` | report high[5] | `081dd30c` | 「超过 T5 微调基线 85%」 |
| `b3040a5a` | report high[6] | `c7a44319` | absence「准确率判定标准」 |
| `36084f49` | report high[7] | `bd535396` | 「请 10 位同学试用打分」 |

运行时本来就是静默丢弃（`app/api/sessions/[id]/end/route.ts:230-232` 的 `.filter((h) => claimById.has(h.claim_id))`、`app/api/sessions/[id]/answer/route.ts:205-206` 的候选集校验），所以这 5 条之前是"悄无声息地少掉 4 条高危 + 2 条追问"。修好后实测：

- 建会话 200，`question.claimId = 235eef4d…`，claim 建在 `absence` 锚点上，正常
- 完整走一轮 answer，追问正常落回 `235eef4d…`
- `end` 出报告：`high_risk` **8 条**（原来只有 4 条能活）、`advice` 339 字

### 验证重抽不再打断锚点

```
重抽前 17 条 snapshot → POST /api/docs/{id}/claims → 重抽后 17 条
same=17  diff=0    种子缺=0
```

同锚点 id 全部保住，种子也对得上。

## 二、看板加长

### 改前实测（1365×853）

```
scrollH=853（零余量，正好卡满）
main.shell 703px @104
三个 .col-body 各 383px @406
section.toolbar 51px @271    h1.wordmark 44px @162    p.lede 43px @214
```

⇒ 列上方固定开销 302px，`.cols` 的 `clamp(280px, calc(100vh - 430px), 680px)` 里那个 430 就是照它写的，余量留得保守。

### 改动

| 位置 | 改前 | 改后 |
|---|---|---|
| `.shell` max-width | `var(--container)`（1080） | **1240px**（三列各得 ~390px，长句少折一行） |
| `.shell` padding | `24px 24px 18px` | `14px 24px 12px` |
| `.wordmark` line-height | 1.3 | 1.15 |
| `.hero-badge` margin-bottom | 8px | 6px |
| `.lede` | `line-height:1.6; margin:8px 0 0` | `1.5; 6px 0 0` |
| `.stat` | `margin-top:12px; padding:9px 0` | `8px; 6px 0` |
| `.toolbar` margin-top | 14px | 10px |
| `.filterbar` | `margin-top:12px; padding:7px 12px` | `8px; 6px 12px` |
| **`.cols` height** | `clamp(280px, calc(100vh - 430px), 680px)` | **`clamp(280px, calc(100vh - 330px), 680px)`** |
| `.cols` margin-top | 16px | 10px |

列高因此从 383px → **483px（+100px，+26%）**，且 `scrollH` 仍是 853 —— 不是靠滚动换来的，是靠把头部 302px 压到 216px 腾出来的。

`330px` 这个常量的来历写进了注释：顶部两条常驻横条 104 + 页头区 216 + 页脚下留白 10。

## 四道闸门

| 闸门 | 结果 |
|---|---|
| `npm test` | **425 / 425 pass，fail 0** |
| `npm run test:fixtures` | **51 项 0 失败**（比之前多 1 项 = 新的锚点层） |
| `npm run build` | 成功，19 路由 |
| `npm run probe:mobile`（400px） | **6/6 无横向溢出** |
| `node scripts/probe-viewport.mjs`（1365×853） | **5/6 一屏**，`/doc` `scrollH=853` |

## Bug 与修复过程

**Bug 1：在 `.mjs` 里写了 TypeScript 类型断言**

`scripts/demo.mjs` 补自愈逻辑时写了 `(q.all(...) as Array<{ id: string }>)`，裸跑 Node 直接 `SyntaxError: Unexpected identifier 'as'`。这个文件是 `.mjs` 不是 `.ts`，类型断言是没有的。改成去掉断言、只留 `(r) => String(r.id)`。

**Bug 2：`test-fixtures.mjs` 里用了未定义的 `ROOT`**

补锚点层时写了 `path.join(ROOT, 'scripts', ...)`，但该文件没有 `ROOT` 常量（它用的是 `process.cwd()`）。跑起来 `ReferenceError`。改成 `path.join(process.cwd(), ...)`。

**Bug 3：锚点层差点把 docId 当成失效 claim_id**

种子的 `doc.id`（`07b4f607-…`）也是 36 位 UUID，会出现在 persona fixture 里。第一版扫全量 UUID 时把 `fixtures/llm/personas.json` 里的 docId 报成"不在种子里"。修法：扫的时候显式排除 `seed.doc.id`（以及 `seed.doc.docId` 这个兼容名）。

**Bug 4：`Invoke-RestMethod` 在中文环境下的两个坑**

`Invoke-WebRequest` 直接报「Windows PowerShell 处于非交互模式」。改用 `node -e` + `fetch` 就干净了 —— 后续所有 API 复现都走 node，不用 PowerShell 的 web cmdlet。

**Bug 5：`answer` 必须先 `next` 拿 turnId**

直接 POST `answer` 只带 `answer` 字段会 400 `E_NO_TURN`（缺少 turnId）。正确顺序是 `POST /api/sessions/{id}/next` → 从返回里取 `pendingTurnId` → 再 POST `answer`。

## 实测截图

`C:\Temp\shots\doc-final.png`（1365×853）：三列看板明显变长，第一列能看到 3 张完整卡 + 第 4 张的头部（改前只能看到 2 张半），底部仍齐平，视口底边不留空。

## 遗留问题

- 报告页仍要滑 1988px（内容量问题，非本轮范围）
- `_demo.out.log` / `_demo.err.log` 是自愈逻辑调试时的临时输出重定向，已删；`npm run demo` 本身不写这两个文件
- 库里 `da5c86e8…` 那条 11-14 早些时候生成的报告是修复前的产物（high_risk 只有 4 条），如果要拿它当演示样例，需要重跑一次 end

## commit

`fix(anchor): 重抽不再换 claim id + 看板加长（列高 383→483px）`

## 追加（同日下午）：卡片内距收紧，让 125% 下三列各露 3 张卡

用户反馈「我实测 110% 才能看到三张卡」。量了才知道不是看板高度不够，是**卡片本身太高**：

- 列内可视 482px，而改前三列卡片高 `161px`，`161 × 3 = 483 > 482` —— 第 3 张永远差 1px 被裁，视觉上就是「只看到 2 张半」。
- 把卡片内距从 `padding: 12px 14px / margin-bottom: 8px` 收到 `10px 14px / 6px`、`.meta` 上边距 `10px → 8px` 后，单卡降到 `153px`（首张 `128px`），`153 × 3 = 459 < 482`，三列都完整露 3 张，第 4 张还能露个头部。

实测（`Emulation.setDeviceMetricsOverride`，同 Edge 内核）：

| 视口（缩放） | 列内可视 | 每列完整卡片数（列1/2/3） | 页面 scrollH |
|---|---|---|---|
| 1707×1067（100%） | 639px | 4 / 4 / 4 | 1067（不滚） |
| 1551×970（110%） | 599px | 4 / 3 / 3 | 970（不滚） |
| **1365×853（125%）** | **482px** | **3 / 3 / 3** | **853（不滚）** |

即：改完之后 **125% 就能看到三张完整卡**，不必降到 110%。字号阶梯（13.5px）与行距（1.65）都没动，只压内距。

截图：`C:\Temp\shots\doc-125-3cards.png`（1365×853，138373 B）。
