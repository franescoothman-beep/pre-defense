# 2026-11-02 阶段 6 收尾：人工判据回填 + 评测表进文档 + 挂账清账

## 目标

阶段 6 九项任务在前一轮已全部完成，这一轮只做三件收尾事：

1. 把 `docs/eval/eval-result.json` 里两项**人工判据**（类型抽检一致率 / 证伪有效性）从"样本已导出、待人工填"变成有数字、有理由、可复核
2. 按阶段 6 DoD「评测表填满、数字写进技术文档（标注样本量）」把八项指标写进 `开发流程详细文档.md`
3. 清掉两条挂账：`report.v1.ts:78-79` 重复行、high_risk 缺「同一根因合并成一条」规则（后者必须重录 fixture）

顺带把 11-10 冻结动作写成可照抄的清单，避免当天临场想步骤。

## Prompt 原文（关键指令）

用户本轮指令就是恢复口令 + 按第三章与 DoD 执行：

> 根据 @CLAUDE.md @progress.md 的"下一步"进行任务，并且按照 @开发流程详细文档.md 的第三章和dod进行

第三章指系统契约（锚点模型、`risk_score` 服务端聚合、`kind` 两类），DoD 指阶段 6 那 6 个复选框。

## AI 输出摘要

- 新增 `scripts/fill-human-judgement.mjs`：把 12 条逐项判定写进 JSON，带两条一致性校验
- `开发流程详细文档.md` 新增 §4.4 评测结果（八行表格 + 样本量列 + 两条口径说明 + 三份使用记录表）
- 阶段 6 DoD 六个复选框全部勾选，每个后面注明证据位置
- `lib/prompts/report.v1.ts`：删重复行 + 补 high_risk 同源合并规则（4 行）
- 重跑 `record-fixtures.mjs`（会话 `1087ad7f`），5 个 fixture 全部重录
- `progress.md` 升 v2.1.7，新增 11-10 冻结清单（可复制的 PowerShell 命令块 + 冻结后允许改动边界）

## 我的修改

### 1. 人工判据怎么判（这是本轮唯一需要人真的动脑的地方）

12 条样本是内置样例材料的**全部** claims（原计划抽 20 条，该材料只有 12 条，所以全量）。逐条判两件事：

- `type_check`：`model_type` 三选一（method / engineering / value）是否与质疑文本匹配
- `falsification_validity`：给出的 `quote` 是否真的支撑这条质疑

实际判定结果 12/12 全过，但每条都写了理由（落在 `human.sample[].note`）。举三个我犹豫过的：

- **#9 / #12 判 value 而非 method**：这两条问的是"增量价值在哪""对应哪项可操作管理动作"。它们技术上也沾方法，但质疑的核心是**价值判断**（这模型到底有啥用），所以归 value。判断标准是"模型答完后，要改的是方法还是定位"。
- **#4 是 absence 类**："是否考虑学校层面聚类效应"——原文里根本没有这句，是模型判断"应该提但没有"，所以走 absence 通道、`scope` 交给机检。这条命中率单独计入"缺失类检索覆盖率"分母（1 条），不进 quote 分母。
- **#3 语序**：原文"我们认为该结论可以推广到全市乃至全省的课后服务管理场景"，quote 与本句逐字一致，`verified=1`。

**为什么全过还要写理由**：12/12 看起来像"自己给自己打满分，没有区分度"。但这是**抽检**，不是能力评估——目的是"发现机检抓不到的错判"。如果我不把理由写出来，将来没人能复核这 12/12 是真判过还是随手填的。理由写下来，复核者可以逐条推翻。

### 2. 评测表为什么必须带样本量列

原表只有"目标"和"实测"两列，`100%` 看起来完美。但分母是这样的：

- 引用命中率 11 条（2 场 × 3 问 + 追问）
- 缺失类覆盖 **1 条**
- 双采样一致性 **3 组**
- 追问收敛 **2 场**

`1/1 = 100%` 和 `11/11 = 100%` 的说服力差一个量级。申请表里我强制加了"样本量"列，并在正文补一段：

> 这些数字能证明**管道是通的、机检是生效的**，不能用来声称"命中率已经稳定在 100%"。

这段是给评审看的，也是给未来的自己看的——省赛评审如果追问"你这个 100% 跑了多少条"，答案不能是"我没数"。

### 3. 修改 prompt 后的连锁动作（走了完整铁律流程）

`report.v1.ts` 改了 5 行，按铁律 3 + CLAUDE.md「改完 prompt 或 schema 必须跑 test:fixtures」：

1. 起真实 key 服务（`MOCK_LLM=0` + `LLM_CAPTURE=1`，端口 3111）
2. `node scripts/record-fixtures.mjs` → 会话 `1087ad7f`，落盘 5 个 fixture
3. `npm run test:fixtures --verbose` → **39 项 0 失败**
4. 重启 mock 服务 → `node scripts/verify-demo-loop.mjs` → 三问正确、高风险 7 条、`[OK] 零 key 闭环走通`
5. `npm test` → 414/414
6. 提交 commit `488bbdb`

**检查项从 41 降到 39 不是失败**：`test-fixtures.mjs` 的 locator 检查条数跟着 fixture 里的条目数走。新 report fixture 是 3 个 material_risk 维度（原 4 维），locator 总条数少了 2 条，检查项就少了 2 项。失败数仍然是 0。

### 4. 新 prompt 的效果验证（这才是改 prompt 的意义）

同一个材料、同一个模型，只换了 high_risk 段落：

| | 改前 | 改后 |
|---|---|---|
| high_risk 条数 | 8 | 7 |
| 其中同源重复 | 3 条（"意愿当行为" / "300 米无出处" / "标题措辞"其实是同一处概念与操作定义不一致） | **0 条** |
| material_risk 维度 | 4 | 3 |
| advice 字数 | ~250 | 377 |

**条数从 8 降到 7，覆盖面反而更宽**——这正是那句"把同一处缺口换成三种问法占掉三个名额，等于用条数冒充覆盖面"要的效果。7 条分别打在：交叉验证、抽样规则、反向因果、方差解释、可操作决策、外部验证、因变量测量。没有一条是另一条的换皮。

## Bug 与修复过程

### Bug 1：fixture 文件结构记错了，`require` 出来的不是数组

想快速看一眼新录的 report fixture 有几条 high_risk，写了：

```js
const r = require('./fixtures/llm/report.json');
const x = r[0];
```

报 `TypeError: Cannot read properties of undefined (reading 'response')`。

**根因**：fixture 不是裸数组，真实结构是

```json
{ "notes": "MOCK 回放：…", "seq": [ { "inputHash": "report1", "response": { … } } ] }
```

我上一轮的记忆里是 `[{inputHash, response}]`，但录的时候外面包了 `{notes, seq}`（因为每个 fixture 文件头要写"这个回放是干什么的、有什么坑"）。

**修复**：改用 `raw.seq[0].response`。并把这件事记在 ai-log 里——**这类"结构记错"是驱动脚本最常见的静默错误**，它不报错（`r[0]` 就是 `undefined`），只是让你后面全都拿不到东西。上一轮 `collect-usage.mjs` 三处字段名猜错（`token.t` / `meta.persona` / `evaluation` 不是 `evaluate`）是同一个病。

**教训**：写查看脚本时，先 `JSON.stringify(raw).slice(0, 400)` 看一眼真实结构，再动手取字段。多花一次工具调用，省掉三次猜错重试。

### Bug 2：PowerShell 内联 `node -e` 含正则就炸

想验证构建产物里有没有散点相关的 class：

```
node -e "... .match(/\/_next\/static\/.../) ..."
```

PowerShell 报 `表达式或语句中包含意外的标记`。

**根因**：PowerShell 先解析双引号字符串里的 `$`、反引号、以及转义序列，`\/` 这类东西会把它搞乱。**这不是 node 的问题**。

**修复**：一律落盘成 `.mjs` 再 `node scripts/xxx.mjs` 跑。本会话所有查看脚本都这么干，用完立即 `Remove-Item`。

### Bug 3：`fill-human-judgement.mjs` 第一版没有分母校验

第一版直接 `sample.forEach((s, i) => { s.type_ok = VERDICTS[i].type === 'pass' })`。如果判定数组短一条，`VERDICTS[i]` 是 `undefined`，`undefined.type` 直接抛 TypeError；如果长一条，多的那条**被静默忽略**，分母就错了，比例算出来是错的但不会报错。

**修复**：加两条显式校验，宁可报错也不要静默算错分母：

```js
if (VERDICTS.length !== sample.length) throw new Error(`判定 ${VERDICTS.length} 条，样本 ${sample.length} 条，不一致`);
if (VERDICTS[i].no !== sample[i].no) throw new Error(`第 ${i} 条 no 对不上`);
```

第二条更关键：长度对得上不代表顺序对得上。判定表是手写的，样本是按 risk 降序导出的，两边顺序一旦错位，`type_ok` 会贴到错误的条目上——**这种错不报错、数字还很好看**，是最危险的一类。

## 结果

| 项 | 状态 |
|---|---|
| 类型抽检一致率 | **12/12 = 100%**（目标 ≥80%），每条带理由 |
| 证伪有效性 | **12/12 = 100%**（目标 ≥80%），每条带理由 |
| 技术文档 §4.4 | 八项指标表 + 样本量列 + 两条口径说明 + 三份使用记录表 |
| 阶段 6 DoD | 6/6 全勾 |
| `report.v1.ts` 两条挂账 | 已清（重复行 + 同源合并规则） |
| fixture 重录 | 会话 `1087ad7f`，5 相全部重录 |
| `npm test` | 414/414 |
| `npm run test:fixtures` | 39 项 0 失败 |
| 零 key 闭环 | 通过（三问 / 高风险 7 条 / risk_score 81） |
| 文档 UTF-8 | progress.md 28785 / 技术文档 42269 / eval-result.json 7866，`U+FFFD` 全 0 |
| commit | `488bbdb`（prompt + fixture）、`b6e2136`（人工判据 + 文档） |

## 遗留问题

1. **absence 类样本只有 1 条**。"缺失类检索覆盖率 100% (1/1)"这个数字本身没有统计意义，只是证明 absence 通道通了。要拿到有意义的数字，得找一份"该说什么却没说"特征明显的材料（比如只有结果没有方法的摘要）。**不打算为凑数字造材料**——表里已注明样本量，评审能看出来。
2. **超长文档的 quote 命中率会掉**。狗粮材料 476 块，命中 56/67 = 83.6%，未命中的多是 `block_idx` 数错且超出 ±2 邻域。这是"模型要把 476 个编号数对"的固有难度，不是 bug。**已知边界，写进表里了**。
3. **5 分制锚点没写进给评委看的文档**。`SCORE_LABEL` 在 `lib/prompts/evaluate.v1.ts` 里逐档写死了（0 空答 / 1 基本没接上 / 2 明显绕开 / 3 方向对但含糊 / 4 成立差一处 / 5 答清了），但 README 和技术文档里没抄一份给人看。**挂账**，11-11 做交付物时补。
4. **y 容差 2.5 无标定**。PDF 解析层的实现细节，狗粮自查提出来了。改动风险大于收益，**挂账不改**。

## commit

- `488bbdb` `refactor: merge same-root-cause items in high_risk + drop duplicated prompt line`
- `b6e2136` `test: fill human-check metrics for stage-6 eval table`
