# 阶段 6（一）：fixture 五相齐 + 零 key 闭环 + 评测八项 + prompt-eval 三组

- 日期：2026-11-02
- 范围：`npm run test:fixtures`、`MOCK_LLM` 零 key 闭环、`scripts/eval.mjs`、`docs/prompt-eval/`
- commit：（见本文件末尾）

## 一、目标

阶段 6 的九条里，先清掉能机检的四条：

1. `evaluate` / `report` 两个 fixture 从未录过 → MOCK 零 key 走不到判分之后
2. `question.json` 是"多场各取首问"，不是一场三问
3. `npm run test:fixtures` 得用当前 schema 把全部回放剧本过一遍
4. `docs/prompt-eval/` 至少 3 组 v1 vs v2 同输入对比（官方点名的 Prompt 链证据）
5. `npm run demo` 零 key 走完闭环（阶段 7 复现的前置）
6. `scripts/eval.mjs` 八项机检指标（其中两项人工抽检先导出样本）

## 二、Prompt 原文（节选）

### 2.1 录 fixture（重写 `scripts/record-fixtures.mjs`）

> 目标：录一场**真实的 quick 会话**，从 `logs/llm-capture.jsonl` 里按 phase 取模型
> 过完 zod 的对象落盘；而不是在录制脚本里另写一遍 fetch + 解析 + 校验。

关键决定：**不在脚本里复制产品逻辑**。旧版脚本自己拼 `response`，结果第 2/3 位评委的
`opening.question` 是 `"${p.name}：这条质疑点你怎么答？"` 这种占位串 —— 回放出来的
第 2、3 问全是同一句话。改成"驱动一场真会话 + 从 capture 日志取"之后，落盘的就是
模型真实产出、且已经通过 `lib/schemas.ts` 与 `lib/locator.ts` 的对象。

### 2.2 prompt-eval（新写 `scripts/prompt-eval.mjs`）

> v2 = `lib/prompts/*.v1.ts` 现行 SYSTEM；v1 = 把这些 SYSTEM 的硬约束**逐条拆掉**后的对照物。
> 同一输入、同一温度、同一 response_format，各跑 3 轮，用通过率而不是单次结果下结论。

## 三、AI 输出摘要

- `scripts/record-fixtures.mjs` 重写（~330 行）：驱动 quick 会话（建会话 → 三次流式提问
  → 每问一次 `/answer` → `/next` → `/end`），再从 capture 日志按 phase 落盘五个 fixture。
  personas 落盘前按席位候选集合逐位校验锚点：模型合理就原样留，不合理才换本席位
  risk 最高的那条，且**换锚点不换问题**（问题用系统真实问过的那句）。
- `scripts/test-fixtures.mjs`（282 行）：三层校验（zod 结构 / locator 机检 /
  personas 三位 claim_id 互不相同），`npm run test:fixtures` 挂进去。
- `scripts/eval.mjs`（~260 行）：八项机检，两项人工抽检导出样本。
- `scripts/prompt-eval.mjs`（~400 行）：三组 v1 vs v2，每组每版 3 轮。
- `scripts/dump-demo-seed.mjs` + `scripts/demo.mjs` 播种：让 fresh clone 也有样例材料。

## 四、我的修改（关键几处我改了什么、为什么）

1. **`lib/llm.ts` 加 `LLM_CAPTURE` 钩子**：真实调用成功后把 `{phase, system, user, response}`
   追加到 `logs/llm-capture.jsonl`。理由：录制要的是"过完 zod 之后的对象本身"，在录制脚本里
   另写一遍解析等于把重试 / extractJson / 校验三段逻辑复制一份，改 schema 后必定跑偏。
   日志落在 gitignore 覆盖的 `logs/`，用完即弃（S4 要求材料与密钥不落库）。
2. **personas 锚点校验放在服务端席位集合上**：`seatClaimIds(seats[i])` 判合法性。
   模型给的 claim_id 若不在本席位候选里，服务端会把那位评委整个过滤掉 → 用户看到 1 位评委。
   这是"锚点必须先于问题存在"的直接后果：问题是从 claim 派生的，claim 不合法就没有问题。
3. **mock 游标键改成 `${sessionKey}:${phase}` 且挂 `globalThis`**：见第五节 Bug 1。
4. **`scripts/prompt-eval.mjs` 的 v1 是"逐条拆约束"造出来的**，不是历史版本。
   拆掉哪条、哪条就出问题——这条因果才是要留的证据，写进 diff.md 的备注里。
5. **采集 3 轮而不是 1 轮**：第一次实测 claims 组 v1 的违规 0 条，第二次 v1 直接把
   `dimension` 写成 `expression`、`type` 写成非法枚举。单次对比会让结论来回翻。

## 五、Bug 与修复过程

### Bug 1（P0）mock 回放三问串成同一问 —— 两个独立根因叠加

**现象**：`npm run demo` 零 key 闭环里，三问显示成
`[问1]这三所小学 [问2]你的模型相比政策 [问3]你的模型相比政策`（q1/q3/q3），
再跑一次变成 q1/q1/q2。

**排查**：日志里出现两次 `seq=0 idx=0` 才走到 `seq=1`。

**根因 1：游标只按 sessionKey 计数，三个 phase 共用同一个 key。**
`question`（stream:291）、`evaluate`（answer:136）、`report`（end:134）三处都用 `session.id`
当 sessionKey。一次 `/answer` 里先跑 evaluate，游标 +1，下一次开流取 question 时就从
第 2 条开始 —— 跳过了一问。

**根因 2：游标是模块顶层 `new Map()`，Next 热重载会重新求值模块，游标被重置归零。**
只把键改成 `sessionKey:phase` 之后仍然复现 q1/q1/q2，因为两次 stream 之间模块被重载了。

**修复**：
```ts
const g = globalThis as unknown as { __mockCursor?: Map<string, number> };
const mockCursor = g.__mockCursor ?? (g.__mockCursor = new Map());
const key = `${input.sessionKey}:${input.phase}`;
```
`resetMockCursor(sessionKey)` 改为按前缀清掉该场所有 phase。

**验证**：`node scripts/verify-demo-loop.mjs` → `[问1]这三所小学 [问2]样本量是多少…
[问3]你的模型相比政策…`，q1→q2→q3 正确，3 位评委全到。

### Bug 2（P0）fresh clone 走不通零 key 演示

**现象**：`npm run demo` 起 MOCK 服务后，前端禁用上传（mock 模式），而空库里
`/api/demo` 返回 `E_NO_DEMO_DOC` —— 用户点"用内置样例开始"被卡在第二个失败点。

**更深一层**：personas fixture 里锚定的是**具体 claim_id**。空库播种时如果重新生成 UUID，
录制好的 `opening.claim_id` 一个都匹配不上 → 三位评委被过滤成 0 位 → 建会话直接 502。

**修复**：`scripts/dump-demo-seed.mjs` 从真库里导出 `scripts/seed-demo-data.json`
（真实 doc + 10 blocks + 12 claims，**保真 claim_id / block_idx / quote / dimension / risk**）；
`scripts/demo.mjs` 起服务前 `seedIfMissing()` 幂等灌库（仅当库里没有"有 claims 的
sample-paper.docx"时才写，不覆盖真实模式的数据）。

**踩坑**：demo.mjs 最初用裸 `new DatabaseSync` 查表 → `Error: no such table: documents`。
`lib/db.ts` 是懒连接（第一次 `q.*` 调用才建表），裸 open 跳过了建表。改为 `registerHooks`
后 `await import('../lib/db.ts')` 走产品的 `q`/`tx`。

### Bug 3（P1）`tests/llm.test.ts` 的断言随数据过期

`loadAll('evaluate')` 原来断言 `deepEqual([], ...)`，注释里自己写着"这是结构上不可能有
fixture 的 phase"。阶段 6 录完之后这条必然变红。改成断言 `length >= 1`，另用真正
不可能的 phase（`nonexistent_phase`）来测"空返回不抛"这件事本身。

### Bug 4（P1）eval.mjs 的 verify 调用签名写错

第一版按"返回对象里带 locator"写：`verifyQuote(BLOCKS, {kind,block_idx,quote})`。
实际签名是 `verifyQuote(blocks, blockIdx, quote)`，返回 `{verified, resolvedBlockIdx, movedBy, reason}`。
结果 quote 命中率恒为 `0/12` —— 一个把"全部命中"报成"全部未命中"的静默错误。
改成按真实签名调用后 12/12。

### Bug 5（P2）`z.object` 会静默 strip 未知字段，导致"越界判据"测不到

report 组要测"模型有没有越界给材料分"。第一版用 `safeParse` 的结果判断，
但 zod 默认会 strip 掉 `risk_score` 这类未声明字段 → `safeParse` 通过，
`m.risk_score !== undefined` 永远 false。**判据必须看模型原始输出**。
改成读 `r.parsed.material_risk`（未过 schema 的原始 JSON）之后就测出来了：v1 2/3 轮给分。

## 六、结果

| 项 | 结果 |
|---|---|
| `npm run test:fixtures` | **41 项 0 失败**（claims / personas / question / evaluate / report 五相） |
| `npm test` | **413 / 413 全绿** |
| 零 key 闭环 | **走通**：样例 → 三问（q1/q2/q3 正确）→ 报告（4 维材料风险 + 4 维临场表现 + 8 条高风险） |
| `scripts/eval.mjs` | 引用命中 **100% (11/11)**、缺失类覆盖 **100% (1/1)**、双采样一致 **100% (3/3)**、追问收敛 **100%**、quick 最长 **43.1s**（上限 480s） |
| `docs/prompt-eval/` | **3 组 × 2 版本 × 3 轮 = 18 次真实调用**，落 `diff.md` + 每组 `v1.json`/`v2.json` + 两套 system 原文 |

### prompt-eval 三组的关键数字

- **claims**：v1 zod 通过 2/3（非法枚举 `type`），v2 3/3；absence 出口 v2 3/3 轮会用、v1 0/3
  —— 不给"这里没有"的合法出口，模型就硬凑一句引用，直接污染命中率。
- **evaluate**：v1 **3/3 轮把 5 分制改成百分制**（score=18），v2 0/3
  —— 不把五档判定条件写死，模型会另起一套量纲。v1 zod 0/3。
- **report**：v1 quote 命中 **0/19**，v2 **9/9**；v1 **3/3 轮把 locators 写成字符串数组**
  （线上真实踩过的报废坑）、2/3 轮越界给材料分。

## 七、遗留问题 / 下一步

- 阶段 6 剩余：**UI 打磨**（报告每维加 3 个评委打分散点 + "未覆盖"文案改口）、
  **单测扩到 12+**（补 mock 回放、upload 校验）、**3 份真实使用记录**、**11-10 build + tag v1.0-freeze**
- `eval-result.json` 的人工两项（类型抽检一致率 / 证伪有效性）样本已导出（12 条，材料只有
  12 条 claim 不足 20），需人工判后回填
- `lib/prompts/report.v1.ts:78-79` 有两行重复（编辑残留），v2 原文留档时未清理，
  等 UI 打磨那一轮一并改（改 prompt 必须重跑 `test:fixtures` + 重录 report fixture）

## 八、commit

见下一次 `git log`。
