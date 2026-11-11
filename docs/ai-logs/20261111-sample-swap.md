# 2026-11-11 更换演示样例：课后服务论文 → 教务 RAG 问答论文

## 目标

用户认为原内置样例（课后服务管理效率论文）不能突出产品功能。经确认：新样例改为「基于大模型的教务场景检索增强问答系统」类毕业答辩论文，**保留文件名 `sample-paper.docx` 直接替换**，旧案例从内置链撤下。新论文刻意埋入典型答辩坑（评测集污染、无同配置基线、指标虚高、样本极小、过度泛化），使锚点溯源 / 追问收敛 / 风险分三个卖点全部可展示。

## 为什么换

- 旧论文（课后服务、1240 条问卷、多元线性回归）的质疑点偏社科统计，IT 背景评委的追问不够「句句能听懂」。
- 新论文的坑全部是 AI 项目答辩的高频死穴，评委（method/evidence、logic/value、depth/engineering 三席）每席都有高价值锚点可咬。
- 新样例 17 条 claims 中 risk 4–5 有 12 条（旧样例大量 risk 3–4），「可下降空间」更强。

## 动手前勘察（关键机制）

- mock 回放序号驱动（C15），不按内容路由：换案例只需重录 `fixtures/llm/*.json`，mock 引擎零改动。
- 录制正路 = `scripts/record-fixtures.mjs` 头注释：`MOCK_LLM=0 LLM_CAPTURE=1` 起 dev → 上传抽 claims → 跑 quick 会话 → 从 `logs/llm-capture.jsonl` 落盘 5 个 phase。
- docId 对齐：seed 灌库用 seed JSON 里的 `doc.id`，`record-fixtures.mjs:35` 的 `DOC_ID` 常量须与之一致。
- seed 的 `content_hash` 取自 docx 文件 sha256（`dump-demo-seed.mjs:52-53`）→ **必须先换 docx 再导 seed**。

## 执行步骤（实际发生）

1. **新论文撰写**（11 段，4 章）埋坑：① 800 条评测集多轮调优（测试集泄漏）② T5 基线 85% 来源含糊 ③ 96.8% 无置信区间 ④ 10 位同学 4.6/5 样本极小 ⑤ 声称推广政务/医疗 ⑥ 82%→96.8% 提升全来自调评测集。
2. **docx 手工构造**：`data/build-docx.cjs`（CRC32 查表法自实现 zip），复用旧 docx 非正文条目、只换 `word/document.xml`。坑：复制的 zip 条目被二次压缩 → mammoth 报 `Cannot read properties of null (reading 'tagName')`；修复 = 复制前 `zlib.inflateRawSync(e.data)` 解出原始字节再 deflate。
3. **替换 fixture**：`fixtures/demo/sample-paper.docx`（新 docx，sha256 前 16 = `9760cb28d2ccebab`）+ `fixtures/demo/sample-paper.blocks.json`（11 块：0/2/5/9 标题 + 正文 1/3/4/6/7/8/10；批次 [[1,3,4,6,7],[8,10]]）。
4. **真实 key 录制**：`MOCK_LLM=0 LLM_CAPTURE=1` dev@3111 → 上传（新 docId `07b4f607-5393-4617-82b4-a5ea67e605dc`）→ 抽 claims（17 条：15 quote + 2 absence，quote 命中率 1）→ 改 `record-fixtures.mjs`（DOC_ID + ANSWERS 3 条 + FOLLOWUP_ANSWERS 2 条为新论文学生口径）→ 录 personas/question/evaluate/report 4 个 phase。
5. **claims.json 重生成**：`record-fixtures.mjs` 跳过 claims phase，单独从 capture 落盘（batch0 12 条 + batch1 5 条）；capture 文件带 BOM 需 `.replace(/^\uFEFF/,'')`。
6. **dump seed** → `scripts/seed-demo-data.json`（docId 保留 `07b4f607-…` 新 id，`record-fixtures.mjs:35` 同步）。
7. **文案清理**（grep 1240/三所小学/课后服务等 160 处命中，三类处置）：
   - 必改 8 处：`verify-demo-loop.mjs` DEMO_ANSWER、`eval.mjs` ANSWER、`collect-usage.mjs` answers×5、`dry-run-shoot.mjs` ANSWER、`lib/demo.ts:7`、`lib/grade.ts:116`、`lib/sse.ts:181` 注释。
   - record-fixtures.mjs 录制时已改。
   - 不改：`docs/prompt-eval/*`、`docs/eval/*`、`docs/usage/*`、`docs/ai-logs/*`、`docs/recordings/*`、`scripts/prompt-eval.mjs`（历史证据链，prompt-eval 25% 挂靠）；tests 自造数据自含。

## Bug 与修复过程（2 个大坑）

### Bug 1：E_NO_ANCHOR（评委锚点全失配）

- 复现：重灌 seed 后 verify-demo-loop 抛 `E_NO_ANCHOR`。
- 根因：personas fixture 的 `opening.claim_id` 是录制时服务端分配的库内 id；落 fixture 后为拿 claims capture **重抽了一次 claims**（route 先 delete 再抽）→ 库内 17 条 claim 全换新 id → seed 与 fixture 锚点全失配。
- 修复：**seed 侧 id 对齐 fixture**——每席位组取 risk 最高的 2 条 claim id 改写为 fixture 引用的 6 个 id（`data/fix-seat-order.mjs`）：c80bc909→235eef4d、ddb04b52→49f7db76、274ba330→8aec927e、ba27ac6d→67822d40、232f02b3→87dcfe42、5c290727→5b4c4413。

### Bug 2：评委只落库 1 位（席位顺序错位）

- 复现：E_NO_ANCHOR 修复后复验，`[session] 评委 1 位` FAIL。
- 排查：`data/diag-seats2.mjs` 精确复现 `planSeats`（lib/prompts/personas.v1.ts:115）：席位按（维度,类型）组合排，维度按 claim 数降序。重抽后分组计数 evidence(7)>logic(6)>depth(4) → 席位序 [evidence/method, logic/value, depth/engineering]，而 fixture 评委序是录制时的 [method, engineering, value] → 按索引对齐后许/周的 opening 不在本席位候选内被丢。
- 修复：**调 seed 分布让席位顺序回到录制序**——把 2 条 logic/method claim（`e038d24a` r5、`081dd30c` r4，均非 opening 锚点）的 dimension 改成 depth → dims 变 evidence(7)>depth(6)>logic(4) → 席位序恢复 [evidence/method, depth/engineering, logic/value]，锚点 id 与 5 个 fixture 全不动。

## 经验教训

1. **fixture 引用库内 id 时，落 fixture 后不能再重抽**——capture 抓的是「当时库里的 id」，任何后续 delete+insert 都会使 fixture 失配。正确顺序：抽 claims → 录 personas（锚定当时 id）→ dump seed（导出同一批 id），中途不要重抽。
2. **席位顺序是 claim 分布的函数**：改库内 claim 的 (dimension,type) 计数会重排席位，进而影响 personas 按索引对齐。换案例类操作后必须用 `planSeats` 模拟脚本核对席位序 == fixture 评委序。
3. mammoth 报错不指明 part；用其内部 xmldom（`mammoth/node_modules/@xmldom/xmldom`）逐 part parseFromString 定位。
4. PowerShell `node -e` 内嵌多行 JS 引号转义屡败 → 统一写 .mjs 诊断脚本再跑。
5. PowerShell `Get-Content` 读 UTF-8 JSON 会 GBK 双重编码损坏（铁律 8）；校验 JSON 一律 `node -e` 或写 .mjs。

## 验收

| 闸门 | 结果 |
|---|---|
| `npm test`（node --test） | **425/425 pass, fail 0** |
| `npm run test:fixtures` | **检查项 50 · 失败 0**（claims 变多后机检项从 39 增至 50） |
| `next build` | **✓ Compiled successfully**（19 路由不变） |
| `verify-demo-loop.mjs`（MOCK 零 key 闭环） | 17 claims → 评委 3 位 → 3 问（陈/许/周）→ material_risk 4 维 / performance 4 维 / 高风险 4 / risk_score 75 → **[OK]** |

新报告问答回放样例：问 1「这 800 条评测集在调优时是全部参与迭代，还是划出了独立测试集」（陈评委·evidence 席）；问 2「当检索片段与问题不相关或为空时，你的提示词和流程具体怎么处理」（许教授·engineering 席）；问 3「从教务问答这一个评测集，到政务、医疗等垂直领域的推广结论」（周评委·value 席）——三个卖点（锚点溯源/追问收敛/风险下降）在报告页均可见。

## 契约偏离

- 无 schema/API 契约变更。`lib/demo.ts`、`lib/grade.ts`、`lib/sse.ts` 属冻结红线文件，但改动仅为注释文案（与样例内容强相关，豁免类）；`scripts/*` 为演示脚本非 `app/`、`lib/` 逻辑。功能冻结未解冻。

## 遗留

- `lib/schemas.ts:71`、`docs/technical-doc.md:87` 注释里的旧样例示例句未改（schema 示例文档性质，后续顺手改）。
- docs/prompt-eval 历史证据仍基于旧样例（按决策不改写历史）。
- `v1.0-provincial` tag 仍按计划 11-18 提交时打。

## commit

`git add` 16 文件（2 fixture + 5 llm fixture + 3 lib 注释 + 6 scripts）→ commit 见 git log。
