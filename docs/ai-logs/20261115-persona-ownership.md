# 2026-11-15 人设行生命周期：一场的人设跟着那一场活多久，就活多久

## 目标

上一轮收尾时顺带发现的缺陷（用户批准「一起修了」）：

`app/api/sessions/route.ts` 建新会话时执行
`delete from personas where doc_id = ?`，把这份材料**所有历史人设**整批删掉。
后果是旧会话 `turns.persona_id` 全部变成悬空外键——报告页审议轨迹统一显示「评委」。

实测踩中：session `539746c6`（录制演练那场）的 seq1/seq2 署名丢失。

## Prompt 原文

> 一起修了

## 排查

直读 `data/app.db`：session `539746c6` 的三条 turn，
`persona_id` 分别是 `7077fce5` / `7c91d4bb` / `a5d85996`，
其中前两个在 personas 表里已经查不到行（后来那场会话 `c7076696`
建会话时把旧人设整批删了）。

同时确认：**人设写入必带 `session_id`**（当前代码如此），
`loadPersonas` 第一级按 `session_id` 取——多场并存互不污染，
**整批删除的前提已经不存在**。这个 delete 是 `session_id` 列出现之前的历史遗留。

## 修法（写侧 + 读侧）

### 写侧：只清遗留行

`app/api/sessions/route.ts`：

```ts
// 旧：delete from personas where doc_id = ?
q.run(`delete from personas where doc_id = ? and session_id is null`, docId);
```

唯一要清的是迁移前的遗留行（`session_id is NULL`）：它们不属于任何一场，
留着只会让 `loadPersonas` 第②级兜底捞到错误批次。
带 `session_id` 的人设属于那一场，必须保留。

### 读侧：悬空署名按席位轮转规则回推

人设行已经没了的旧会话（如 `539746c6`），id 永远找不回来。
但**回推不是猜**：persona 席位是状态机按主问序号轮转的
（`personaIndexOfMain(mainIndex, mainsEach, judges)`），
同一条规则当初把 persona_id 写进 turn，按同一条规则就能推回来。

`lib/session.ts` 新增：

```ts
export function personaOfTurn(
  turn: Pick<TurnRow, 'seq' | 'kind' | 'personaId' | 'round'>,
  turns: TurnRow[],
  personas: PersonaRow[],
  mainsEach: number,
): PersonaRow | null
```

1. `personas` 为空 → null
2. `personas.find((p) => p.id === turn.personaId)` 直接命中 → 返回（正常路径）
3. miss → 数到这条 turn 为止的主问条数 `mainIndex`；
   `mainIndex < 0` 返回 null（**不编席位**——这条 turn 之前没有任何主问时，
   硬凑第 0 位就是把错署名写进证据）；
   否则 `personaIndexOfMain(mainIndex, mainsEach, personas.length)` 回推。

**五处消费方全部接线**（少一处就会出现"两个页面显示的评委不一样"）：

| 文件 | 原来 | 现在 |
|---|---|---|
| `app/api/sessions/[id]/route.ts`（历史） | `personaById.get(t.personaId)` | `personaOfTurn(t, turns, personas, mainsEach)` |
| `app/api/reports/[id]/route.ts`（审议轨迹） | `personas.find((x) => x.id === t.personaId)` | `personaOfTurn(...)` |
| `app/api/sessions/[id]/end/route.ts`（askedDims + turnsForModel） | 同上 find | `personaOfTurn(...)` |
| `app/api/sessions/[id]/answer/route.ts`（判分署名） | `find(...) ?? personas[0]` | `personaOfTurn(...)`，null 时 409 `E_NO_PERSONA` |
| `lib/session.ts` `currentQuestion` pending 分支（SSE 重播） | `find(...) ?? personas[0]` | `personaOfTurn(...) ?? personas[0]` |
| `app/api/sessions/[id]/next/route.ts` pending 分支 | 同上 | 同上 |

其中 answer 路由最特殊：它把**判分署名**写进 turns（score/gaps 挂谁名下），
静默退第 0 位等于无声无息地把许教授的分记到陈评委头上——
所以这里不许兜底，回推失败直接 409 把问题摆到台面上。

`lib/report.ts` 的看板行头走 `personas.find(p => p.role === type)`（按席位类型匹配，
不依赖 turn 的 persona_id），本来就悬空安全，不需要改。

## 规格测试

`tests/persona-ownership.test.ts` 6 条（剥注释扫源码）：

1. 建会话**不许** `delete from personas where doc_id = ?`（整批删）
2. 必须是 `delete from personas where doc_id = ? and session_id is null`（只清遗留行）
3. `personaOfTurn` 必须导出，且精确命中在回推**之前**（顺序反了会在能命中时也去回推）
4. `mainIndex < 0` 必须返回 null（不编席位）
5. answer / next / stream 三路由**不许再有** `personas.find(...) ?? personas[0]` 的静默兜底
6. 报告轨迹 / 会话历史 / end 路由都走 `personaOfTurn`

## Bug 与修复过程

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 旧会话报告页审议轨迹统一显示「评委」 | 建新会话整批删 `personas where doc_id = ?`，旧会话 turns.persona_id 悬空 | 写侧只清 `session_id is null` 的遗留行；读侧 personaOfTurn 按席位轮转规则回推 |
| 2 | answer 路由改到一半出现两个 `const matrix`（`matrixForTurn` 误名） | 编辑时在旧代码块前插入了新声明块 | 收敛为一处声明（:106 matrix → :107 judgesActual），删除后面的重复声明 |
| 3 | 第一版 verify 报告接口 404 | 该会话从没出过报告（录制演练没走到出报告） | 先 POST /end 生成报告再验 trajectory |

## 门禁

| 项 | 结果 |
|---|---|
| `npm test` | **461 pass / 0 fail**（455 + 6 条 persona-ownership） |
| `npm run test:fixtures` | 51 项 / 0 失败 |
| `npm run build` | 成功（无 error） |
| `verify-demo-loop`（BASE=3111，重启后） | `[OK]` 3 问 / 3 评委 / material_risk 4 维 / performance 4 维 / 高风险 8 / risk_score 75 / history 5 条 |
| 旧会话署名恢复 | 历史接口 `1:陈评委 \| 2:陈评委 \| 3:许教授`；报告接口（补出报告后）`1:question:陈评委(evidence) \| 2:followup:陈评委(evidence) \| 3:question:许教授(depth)` —— **全部署名恢复，没有「评委」兜底** |

## 遗留

1. 悬空是**读时回推**，不是把旧 turn 的 persona_id 改写成新 id——报告是证据，
   不许改写已落库的外键。若未来真需要"人设迁移"，应该另立显式迁移脚本并记 ai-log。
2. `personas` 表从"每材料一批"变成"每场一批"，行数会随会话数增长。
   演示库规模下无所谓；若以后要清库，按 `session_id in (select id from sessions)` 保留、
   孤儿行清理即可（与写侧同一条规则）。
3. `lib/report.ts` 看板行头按 `role` 匹配人设名，在"两位评委同 role"的异常数据下
   会取到前一位。当前 planSeats 保证 role 不重复，先不改。

## commit

`fix(session): 人设行不再随新会话整批删除，悬空署名按席位回推`
