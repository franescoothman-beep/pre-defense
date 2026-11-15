# 2026-11-15 录前自检防复发 + quick 追问序列实测

## 目标

1. 录前自检 `scripts/verify-demo-loop.mjs` 从 FAIL（评委 1 位）恢复到全绿，并让它**不再复发**。
2. 确认 quick 档录制时屏幕上到底出现几条追问、分别是哪句 —— 因为 `录制回答稿.md §1.3` 要写「屏幕内应答原句」，写错就等于让录制者准备一句永远不会出现的话。

## Prompt 原文（摘要）

- 「启动服务」→ 跑录前自检，FAIL：`[session] ... 评委 1 位 → [FAIL] 评委数不是 3，疑似锚点失配`
- 「维度分布对齐 seed 加进 demo.mjs 的自检判据（防复发）」
- 「改一下」（段②答案改写为同时接住三条线）
- 「要」（把 a1–a5 追问逐条作答原句补进 `录制回答稿.md §1.3`）

## AI 输出摘要

### 1. 席位 1 位 = DB 维度漂移，不是 id 漂移

- `scripts/diag-seats.mjs` 跑出：live DB `dimension` 分布 `evidence 7 / logic 6 / depth 4`，而 `scripts/seed-demo-data.json` 是 `evidence 7 / depth 6 / logic 4`。
- `app/api/sessions/route.ts` 的 `planSeats(claims, 3)` 按 `(dimension, type)` 计数排席位、维度按 claim 数降序 → 漂移后席位顺序变成 `[evidence·method, logic·value, depth·engineering]`。
- `fixtures/llm/personas.json` 的录制序是 `[陈 method, 许 engineering, 周 value]`，`opening[0]` 分别锚 `235eef4d / 8aec927e / 87dcfe42`。按索引对齐后 许/周 的 `opening` 一条都不在本席位候选里 → `matched = 0` → 被丢弃，`validated.length = 1`。
- **为什么 `demo.mjs` 没自愈**：它的自检判据是「17 条 seed claim id 是否齐全」，id 全在 → 打印「内置样例已就绪，跳过灌库」。**维度分布从不参与判据，所以漂移永远不被发现。**

### 2. 修复 + 防复发

`scripts/demo.mjs` 新增 `syncClaimDimTypes(docId, seed)`：在同一事务里**只 `UPDATE` `dimension` / `type` 两列**对齐种子，返回漂移条数，失败回滚。刻意不动 `block_idx` / `quote` / `risk` / `verified`（那是锚点，动了会让溯源失效），也不删不插（免得误伤「重抽」与真实模式数据）。

接入点：`seedIfMissing()` 的 `missing === 0` 分支：

```
[demo] 检测到维度分布漂移（2 条 dimension/type 与种子不符），已按种子对齐。
```

验证：临时把 `081dd30c` / `e038d24a` 的两条 claim 改回 `logic` 制造漂移 → 重启 demo → 日志命中上面的新分支 → `verify-demo-loop` 回到 3 评委 / 4·4·8 / `risk_score 75` / `[OK]`。临时脚本已删。

### 3. 段②答案全链路改写

旧答案只接住「过拟合 + 单域」两条，q2（许·兜底）完全没被回应，观感像答非所问。新答案（≈95 字）同时接住三条线：过拟合 / 无显式拒答阈值 / 单域验证。同步 4 处：

- `录制回答稿.md §1.2`
- `scripts/dry-run-shoot.mjs` 的 `ANSWER`
- `scripts/verify-demo-loop.mjs` 的 `DEMO_ANSWER`
- `scripts/eval.mjs` 的 `--answer` 默认值

**故意不改**：`scripts/collect-usage.mjs:65` 的 `answers[0]` —— 它是 `docs/usage/` 历史证据链的源头，`20261111-sample-swap.md` 规定历史不改写。

### 4. quick 档追问序列实测：**3 主问 + 2 追问，不是 3 追问**

`scripts/check-followups.mjs` 按真实 UI 状态机驱动（`/next` → `stream` 或 `answer` → 依 `answer` 响应的 `decision` 推进），实测输出：

```
[主问1] 陈评委 :: 这 800 条评测集在调优时是全部参与迭代，还是划出了独立留出集？96.8% 是在哪部分上算的？
  [追问1] 陈评委 :: 这800条里有没有划出一部分完全不参与调优？96.8%是在参与调优的那部分上算的吗？
[主问2] 许教授 :: 当检索片段与问题不相关或为空时，你的提示词和流程具体怎么处理，是拒答还是让模型自由生成？
  [追问2] 许教授 :: 先回到兜底：检索片段为空或与问题不相关时，系统是直接拒答，还是允许模型脱离片段生成？
[主问3] 周评委 :: 从教务问答这一个评测集，到政务、医疗等垂直领域的推广结论，中间缺了哪几步验证？
→ 本段结束

主问 3 条，追问 2 条
```

**为什么周评委没有追问**：`lib/state.ts:178` 的 `mainsDone >= mainsNeeded → 立刻 end` 排在追问判断**之前**（注释写明 C11「报告永不缺席」，主问问完再追问就是超出计划的开销）。第 3 主问答完时 `mainsDone = 3 >= 3` 直接收口，模型此时即便返回了 a5 的 `followup` 也不会落成一轮追问。

推论：`fixtures/llm/evaluate.json` 里 **a2 / a4 / a5 三条追问永远不会出现在屏幕上** —— a2、a4 是「答完追问后的再判分」被 `followupsInRound >= 1` 拦掉；a5 被「主问问完」截断。之前文档里写的「每主问后都接一条 followup（逐条回放）」是错的。

`录制回答稿.md §1.3` 已改为：5 次提问的完整表格 + 答案 A（陈·约 48 字）+ 答案 B（许·约 60 字）+ 明确写出「周评委那条不会被问，不用准备」。

## 我的修改（相对 AI 输出）

- AI 第一次给的 `check-followups.mjs` 没有按 `answer` 响应的 `decision` 推进，而是盲目重调 `/next`，再叠加 `app.db` 里历史 verify 残留的未答 turn，跑出「主问 0 条 / 追问 5 条」这种自相矛盾的结果。**教训：驱动脚本必须镜像真实 UI 的状态机，否则测的是脚本自己的 bug。**
- 第二次解析 SSE 时漏了 `event:` 行（`lib/sse.ts:65` 的 `encodeEvent` 输出 `event: 名\ndata: {json}\n\n`），`done` 事件全丢 → `turnId` 拿不到。改成按 `\n\n` 切块、同时读 `event:` 与 `data:` 才拿到。
- 没有把 `20261111-sample-swap.md` 里的历史判定改掉 —— 那份记录的是当时的事实。

## Bug 与修复过程

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `verify-demo-loop` FAIL，评委 1 位 | `app.db` 里 `claims.dimension` 漂移（`logic 6 / depth 4`），`planSeats` 席位顺序与 `personas.json` 录制序错位 | `scripts/resync-seed-dims.mjs` 一次性对齐；随后把对齐逻辑固化进 `demo.mjs` 自检 |
| 2 | 同上，重启 demo 后仍复发 | `demo.mjs` 只以 claim id 齐全为判据，维度从不检查 | `syncClaimDimTypes()` 接入 `missing === 0` 分支 |
| 3 | 段②答案被问「兜底」时答非所问 | 旧答案只覆盖过拟合 + 单域 | 答案改写成三条线全覆盖，4 处同步 |
| 4 | `check-followups.mjs` 首跑「主问 0 / 追问 5」 | 驱动循环未跟随 `answer.decision`，且被历史残留 turn 干扰 | 重写为镜像 UI 状态机 |
| 5 | 同一脚本 `turnId` 恒为 `null` | SSE 解析只读 `data:` 不读 `event:`，`done` 事件被当普通消息丢弃 | 按 `\n\n` 切块解析 |
| 6 | 文档写「a1–a5 逐条回放」 | 依据 fixture 顺序推测，未实测 | 实测后改为「3 主问 + 2 追问（陈 a1 / 许 a3）」，并解释 a2/a4/a5 为何不出现 |

## 遗留问题

- `app.db` 里仍堆着历次 verify / dry-run 留下的未答 turn。它们不影响新建会话（`loadTurns` 按 `session_id` 隔离），但会让手写的探测脚本误读。若要彻底干净，删 `data/app.db` 后重启 demo 会重新灌种（`syncClaimDimTypes` 也会跟着正确）。
- `录制回答稿.md` 位于**仓库外**（`D:\Claudecode\AI创新应用挑战赛\`，与 `视频脚本.md` 同级），不在本 git 仓库的提交范围。
- `docs/recordings/dryrun-*.md` 4 份尚未入库（历次试录走查记录），本轮一并提交。

## commit

见本文件同批提交：`fix(demo): 维度漂移自愈判据 + quick 追问序列实测校正`
