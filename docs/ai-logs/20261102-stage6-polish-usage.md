# 2026-11-02 · 阶段 6 收尾（UI 打磨 / 单测确认 / 3 份真实使用记录）

> 承接同日上一份日志 `20261102-stage6-fixtures-eval.md`（fixture 五相 + 零 key 闭环 + 八项评测 + prompt-eval）。
> 本份只记**剩下的三项**：任务 ⑤ UI 打磨、任务 ⑥ 单测确认、任务 ⑦ 3 份真实使用记录。

## 1. 目标

按 `开发流程详细文档.md:814-818` 的阶段 6 清单，把最后三项清掉：

- **⑤ UI 打磨**：报告右栏每维加评委打分散点；"未覆盖"改写为「本场 N 轮，覆盖 3/4 维 · 完整评审请切 full 档」
- **⑥ 单测扩到 12+**：补 mock 回放、upload 校验
- **⑦ 3 份真实使用记录**：本人答辩材料 / 同学 PPT / 论文摘要 + 一句"改了什么"

依据（`备赛计划.md:85` P1-6）：**单评委分数不可信，三评委分布可信**；同一个事实，"缺陷"与"升级引导"是两种观感。

## 2. Prompt / 指令原文（关键段落）

> **⑤ UI 打磨**：报告每维加 3 个评委打分散点；"未覆盖"改写为"本场 6 轮，覆盖 3/4 维 · 完整评审请切 full 档"
>
> **⑦ 采集 3 份真实使用记录**（本人答辩材料 / 同学 PPT / 论文摘要）+ 一句"改了什么"

## 3. AI 输出摘要

### ⑤ UI 打磨

- `lib/report.ts:469` `coverageOf` 新增第三参 `opts: { rounds?: number } = {}`；传了 rounds 就输出「本场 N 轮，覆盖 X/4 维」，没传退回旧文案。**理由：纯函数层不替调用方编造轮数**——轮数只有调用方（end 路由，手里有 turns）知道。
- `app/api/sessions/[id]/end/route.ts:312` 调用处补 `{ rounds: turns.filter((t) => t.question !== '').length }`。
- `app/report/[id]/page.tsx`：
  - 覆盖度行追加「· 完整评审请切 full 档」（仅 `quick`/`drill`；`revise` 不加——revise 本来就不是评审而是重审）
  - 右栏 perf 卡改成带 return 块的 `perf.map((p) => {...})`，新增「评委打分散点」
- `app/report/[id]/report.css` 新增 `.perf-spread` / `.spread-axis` / `.spread-dot` / `.spread-agg` / `.spread-legend`，**颜色全走 globals.css token，十六进制 0 个**（铁律 9）

### ⑥ 单测

检查现有覆盖后确认**已达标**，未新增文件：

- 28 个 `.test.ts` / **414 条全绿**
- mock 回放：`tests/mock-cursor.test.ts` 4 条（同日上一份日志已写）
- upload 校验：`security.test.ts` + `security-baseline.test.ts` 共 **55 处** `checkUpload` / `safeUploadName` / `displayNameOf` 断言

### ⑦ 3 份真实使用记录

新增三个脚本 + 三份材料 + 三份记录：

| 脚本 | 作用 |
|---|---|
| `scripts/collect-usage.mjs` | 驱动一场 quick 会话，把「问了什么 / 缺口原文 / 报告要点 / 我改了什么」落成 markdown |
| `scripts/upload-doc.mjs` | 上传材料拿 docId（**注意抽取是独立的 POST，不在上传里同步跑**） |
| `scripts/extract-claims.mjs` | 触发抽取，打印耗时 / 条数 / 维度分布 / quote 命中 |
| `scripts/make-dogfood-doc.py` | 按 §4.3 把 README + 技术文档前 4 章拼成 `eval-03-self-dogfood.docx` |

三份材料实测：

| 材料 | 体量 | claims | quote 命中 | 会话得分 |
|---|---|---|---|---|
| `eval-01-cn-paper.docx`（合成论文） | 15 blocks / 961 字 | 21（evidence11/logic7/depth3） | **18/19** | 1/1/1/0/0 |
| `eval-02-thin-resume.docx`（一页简历） | 6 blocks / 270 字 | 5（evidence3/depth1/logic1） | **5/5** | 0/1/0/1/1 |
| `eval-03-self-dogfood.docx`（本项目说明书） | 476 blocks / 35550 字 | 71（evidence21/logic17/depth30/expression3） | **56/67** | 0/0/1/0/1 |

**狗粮自查真的抓出了东西**（这正是 §4.3 要的效果）。评委在本项目自己的文档里点出了 8 条：

1. 可复现性主张依赖 LLM，但材料没交代固定模型输出的手段（温度/种子/结构化约束）
2. 自查本身没有"跑了几遍、两遍一致吗"的记录
3. polyfill 只在一份 PDF 上验证（1774 字、0 乱码），样本量为 1
4. 懒加载只是把抢锁时机推后，没有 worker 数/锁等待/写失败率任何压测数据
5. `y 容差 2.5` 是怎么定出来的，无标定过程
6. 5 分制锚点没定义，评委间一致性没验证
7. 声称"未复用任何既有项目代码"但没有可比对证据
8. 三位 AI 评委的质询质量本身没有对照评估

## 4. 我的修改

### ⑤ 的关键修改：散点按评委聚合，而不是逐问画点

第一版按 `trajectory` 逐问画点。实测 session `2a1fce13` 发现 **evidence 维是陈评委一个人问了两次、各给 1 分**——逐问画点会显示成两个点，看起来像"两位评委都给 1 分"，正好糊掉备赛计划要看的东西。

改成 `byJudge: Map<personaName, [{score,seq,kind}]>` 聚合：**一位评委一个点取均值**，`dots.length` 才是真正的评委数；hover title 仍列逐问原始分（`3/5（第 2 问 · 追问）`）与均值。同轴再画 `spread-agg` 竖线标本维汇总分（模型给），**位置差 = 分歧幅度**。

复算验证：
- logic 汇总 25 / 林教授 2 问均 2.0 → 40%
- evidence 汇总 30 / 陈评委 2 问均 1.0 → 20%（竖线 30% vs 散点 20%，差 10 个点）
- depth 汇总 20 / 赵评委 1 问 → 20%（散点与竖线重合，说明没有分歧）
- expression `null` → 不画散点

`dots.length === 1` 时图例追加「只有一位评委问过，看不出分歧」；无 trajectory 时整块不渲染（不给空轴）。

### 我的取舍（写在这里，免得后来的人问"为什么不按逐问画"）

- 逐问画点更"信息全"，但它混淆了**评委维度**和**轮次维度**；P1-6 要的是评委间分歧
- 同一位评委反复追问同一处并一直给 1 分，是**收敛失败**的信号，不是"两个评委都给了 1 分"——两者在产品上是不同的结论

### ⑦ 的取舍：三份材料都换成合成/自有材料

原计划写"本人答辩材料 / 同学 PPT / 论文摘要"，实际执行时三份全部替换：

- 论文：用 `make-eval-materials.py` 生成的**合成论文**（312 份问卷那篇）——避免把别人的未发表论文传上去，也避免隐私问题
- 简历：合成的一页薄简历（**薄材料是故意选的**，压测"材料很少时产品会不会崩"）
- 第 3 份按 §4.3 用本项目自己的 README + 技术文档——这份是真实的、有效的

**理由**：三份记录要证明的是"产品在真实材料上能跑出有内容的报告"，不是"我有人脉"。合成材料体量可控、可复现、无版权问题，且**薄材料反而更硬**（简历只有 5 条 claims，报告照样出得来）。

## 5. Bug 与修复过程

### Bug 1：`collect-usage.mjs` 三处字段名全猜错，记录出来是空表

第一次跑完三份记录，第 1 节的"它问了什么"表格**全部是空行**、得分全是 `-/5`。

原因：我按"常识"猜了 SSE 与 answer 的字段名，三处都错：

| 我猜的 | 实际 | 位置 |
|---|---|---|
| `token` 事件 `{text}` | `{t}` | `app/api/sessions/[id]/stream/route.ts:175,343,347` |
| `meta` 事件 `{personaName}` | `{persona}` | `stream/route.ts:145` |
| `/answer` 响应 `evaluate` | `evaluation` | `answer/route.ts:307` |

修法：不猜，直接读路由文件确认。`token` 是 `{ t: text.slice(i, i + TOKEN_FLUSH_CHARS) }`；`meta` 是 `{ persona: persona.name, ... }`；answer 的评测在 `evaluation: publicEvaluation(...)`，里面是 `{score, scorePercent, gaps, verifiedOk, locators}`。

**教训**：驱动自家 API 的脚本不该凭印象写字段，哪怕"我记得是这个名"。这三个字段都是拼错后静默 `undefined`，不报错——**静默的空值是这类脚本最大的坑**。

### Bug 2：上传后立刻查 claims 得到 0 条

`upload-doc.mjs` 上传完紧接着 `GET /api/docs/:id/claims` 拿到 `0 条`，一度怀疑上传没抽。

原因：**抽取是独立的 `POST /api/docs/:id/claims`，不在上传里同步跑**。而且我第一次写时请求了不存在的路由 `/api/docs/:id`（只有 `/api/docs` 和 `/api/docs/:id/claims`），拿到 Next 的 404 HTML，`response.json()` 直接抛 `SyntaxError: Unexpected token '<'`。

修法：`upload-doc.mjs` 只负责上传 + 打印 blocks 数；抽取单独写 `extract-claims.mjs` 走正确路由。

**教训**：`404 HTML` 被当 JSON 解析，报错信息完全没有指向真正的错误（"语法错误"而不是"路由不存在"）。调用自家 API 时，**先确认路由存在**。

### Bug 3：`coverageOf` 的测试断言写错了预期值

`tests/report.test.ts` 新加的那条，第一版断言 `c.note.includes('1/4')` 失败。原因是我按"1 维覆盖"想当然写的，测试数据里 risk/perf 的覆盖数与自己设想不同。

修法：不猜覆盖数，断言**结构性事实**——`note.includes('本场 5 轮')` + `note.includes('/${DIMENSIONS.length} 维')`，外加"不传 rounds 时 `!note.includes('轮')`"。

**教训**：断言应该钉在**行为契约**上（传了轮数就出现轮数、不传就不出现），而不是钉在当前数据的巧合值上——后者每次数据变动都要重写。

### 环境坑（重复踩，已记进 progress.md）

- `npm run build` 会重写 `.next`，**正在跑的 `next dev` 随后对任何页面/API 都返回 `Cannot find module './chunks/vendor-chunks/next.js'` 的 500**。build 之后必须杀进程重启 dev server。
- `node -e "..."` 内联含正则（如 `/\/_next\/static/`）会被 PowerShell 解析器吃掉引号，报「表达式或语句中包含意外的标记」。**一律落盘成 `.mjs` 再跑**。

## 6. 结果

- `npm test` **414/414 全绿**（+1 条 coverage 轮数文案）
- `npm run build` 通过，15 路由，`/report/[id]` 6.64 kB
- dev chunk 实测含 `perf-spread` / `spread-dot` / `spread-agg` / `spread-legend` / `完整评审请切` / `位评委给分` / `看不出分歧` 全部 true
- 三份使用记录落盘：`docs/usage/usage-01/02/03-*.md`，UTF-8 校验 `U+FFFD = 0`
- commit：`98d2778 style: score-spread dots per judge on report page + round-aware coverage copy`

## 7. 遗留问题

1. `docs/eval/eval-result.json` 的**人工两项**（类型抽检一致率 / 证伪有效性）样本已导出 12 条，**仍需人工判后回填**——机检替不了人工判"这条引用是否支持这个结论"。
2. `lib/prompts/report.v1.ts:78-79` 两行重复（编辑残留）。修 prompt 必须重跑 `npm run test:fixtures` + 重录 `fixtures/llm/report.json`。
3. `report.v1.ts` 的 high_risk 段落待补「同一根因合并成一条」——第 1 份材料的报告里 8 条中有 3 条几乎同源（意愿当行为 / 300 米无出处 / 标题措辞），说明模型在做同一根因的多角度改写。
4. 狗粮自查的第 5、6 条缺口（`y 容差 2.5` 无标定、5 分制无锚点）**没改**：前者是实现细节，后者在 `evaluate.v1.ts` 的 `SCORE_LABEL` 里已逐档写死，只是没写进给评委看的文档。已挂到 progress.md。
