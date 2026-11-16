# 预演 Pre-defense · 质询台

> 上传论文 / 项目文档 / 简历 → 三位 AI 评委轮番质询 → 答辩风险报告。
> **每条结论都能点回原文那一句**（锚点 + quote 逐字机检，未命中就灰显，绝不隐藏）。

**参赛作品**：2026 第九届传智杯全国大学生数智创新与 AI 应用大赛 · AI创新应用挑战赛（赛道 id=10039，个人赛）
**选题**：官方推荐选题方向 1「多 Agent 协同工作流看板」示例中「多角色对抗质询系统」的落地实现。

## 10 分钟复现（零 key）

评委只需四条命令，**无需 API key** 即可走完整个产品闭环：

```bash
git clone https://github.com/franescoothman-beep/pre-defense.git && cd pre-defense
npm i                        # 装全量可选依赖，见下方「为什么这样写 npm i」
cp .env.example .env.local   # 默认 MOCK_LLM=1，不需要任何 API key
npm run demo                 # 起服务，浏览器打开 http://localhost:3000
```

然后按界面走：**选内置样例 → 开始质询（quick 档 3 位评委各 1 问）→ 出报告 → 复练**。
全程约 5–8 分钟，**不需要 API key**。

| 步骤 | 预计耗时 |
|---|---|
| `git clone` | ~10 秒 |
| `npm i` | 1–2 分钟（约 400MB，含全平台预编译二进制） |
| `cp` + `npm run demo` | ~20 秒启动 |
| 界面走完一场（quick 档） | 5–8 分钟 |
| **合计** | **≈8–10 分钟** |

### 为什么这样写 `npm i`（实测过两种装法的差异）

**不要用 `npm i --omit=optional`。** 我实测过：

| 装法 | 结果 |
|---|---|
| `npm i` | 一次装齐，`npm run demo` 直接起服务，**全程不联网** |
| `npm i --omit=optional` | 能启动，但 Next 会在**运行期**发现缺 `@next/swc-win32-x64-msvc`，日志打出 `Downloading swc package...` 去联网下载。断网环境直接失败 |

`--omit=optional` 的本意是省掉 `@napi-rs/canvas` 那个 28MB 原生包（本产品只做 PDF 文本提取、不渲染，用 `scripts/polyfill-canvas.mjs` 补替身即可）。但 optional 里**同时**装着 Next 的 swc 编译器二进制和 Tailwind 的 oxide，省掉它们会把"安装期下载"变成"运行期下载"——对评委来说更糟。

**结论：装全量。** 用不到的原生包不会被执行，`polyfill-canvas.mjs` 仍然照常兜底（运行时可能打印一条 `Cannot load "@napi-rs/canvas"`，属预期，不影响结果）。

> 演示模式下界面右上角常驻 `MOCK 演示模式` 角标；上传页只放开内置样例（上传自己的文件会被置灰拦截并说明原因）。这不是限制，是为了让回放与场景严格对齐。
>
> **顶部还有「演示 · 零 key 回放 / 真实 · 实时模型」切换条**：不重启即可在两种模式间切换。切到真实模式后，上传放开、评委发言改走实时模型（需在 `.env.local` 里配 `DEEPSEEK_API_KEY`）。模式的启动默认值仍由 `MOCK_LLM` 决定（`npm run demo` = 演示，`npm run dev` = 真实）。

### MOCK 模式的三个前提（务必知道，否则会误判为故障）

1. **只允许内置样例**：`fixtures/demo/` 提供预置材料。`MOCK_LLM=1` 下上传自己的文件会被**置灰拦截**并提示原因——因为回放剧本与样例严格对应，换成你的材料必然错位。
2. **序号驱动，不是内容驱动**：同一场会话内按 `phase + seq` 递增回放，所以**回答顺序固定**；`inputHash` 只做告警，不参与路由。
3. **角标常驻**：全局 header 与报告页脚注都标注了 MOCK 模式。**不标等于默认在编数据**，所以必须标。

## 数字与可复现证据速查（演示视频里没有这两段）

> **2026-11-16 决定**：演示视频收敛为四段（痛点 / quick 完整预演 / 狗粮段 / AI 协同 ≥2min），
> **「空目录一键复现」与「评测数字」不录进视频，改为本节与技术文档承载**。
> 理由：这两块分别对应官方「评委可一键复现」（可复现 25%）与「评测数字标注样本量」，
> 写进文档评委可以随时翻查、逐条追到文件，比视频里一闪而过更可查。
> 视频里仍会出现 MOCK 角标（段② 本就在画面里）与命中率相关口径，但**不再单独摆一张评测表**。

### 一键复现：四条命令 + 实测结果

命令见上方「10 分钟复现（零 key）」。**空目录实测**（2026-11-16，SSH clone）：

| 步骤 | 实测 |
|---|---|
| `git clone` | 5.4s（SSH；本机 github https 传输层被重置，见下） |
| `npm i` | 108.6s，装 79 个包 |
| `cp .env.example .env.local` + `npm run demo` | 4.4s 就绪（`✓ Ready in 4.4s · mode=mock`） |
| 零 key 走完闭环 | 5 次作答全部写入（63 字/次），报告 **4+4 维 / 高风险 8 / `risk_score` 75 / 5 轮轨迹** |
| `node scripts/verify-demo-loop.mjs` | `[OK] 零 key 闭环走通，共 3 问，评委 3 位` |

> 本机 `github.com:443` 的 https 传输层被重置（`curl 56 / curl 28`），SSH 克隆正常（5.2–5.6s）。
> 这是**本机网络环境**问题，不影响仓库本身；评委按 README 的 https 命令即可，命令本身已在 fresh clone 上验过。
> 另：`npm run demo` 内部直接调 `node_modules/next/dist/bin/next`（不经过 `npx`）——
> 曾实测到 `npm i` 刚收尾时 `npx` 解析不到本地包、**联网装了 next@16.4.6**（本仓库锁 15.5.28），已根除。

### 评测数字速查（样本量与数字同列，不给百分比单独出现）

| 指标 | 数字 | 样本量 | 出处 |
|---|---|---|---|
| 引用命中（评测材料） | 100% | **11 / 11 条** | `docs/eval/eval-result.json` |
| 双采样一致 | 100% | **3 / 3 组** | `docs/eval/eval-result.json` |
| 三份真实材料 · quote 命中 | **86.8%** | **79 / 91 条**（论文 18/19、简历 5/5、狗粮 56/67） | `docs/usage/*.md` |
| 单测 | 全绿 | **467 条用例**（2026-11-16 `npm test` 实测） | `tests/` |
| fixture 校验 | 0 失败 | **51 项** | `npm run test:fixtures` |

**诚实性声明（一字不改）**：

> **这些数字证明的是管道和机检在生效 —— 不是命中率已经稳定。**

**两条必须说清的边界**（否则数字会误导）：

1. 评测八项（11/11、3/3）与 79/91 是 **11-02 用真实 key 跑的，跑的是换样例之前的「课后服务论文」**；
   11-11 换成教务 RAG 论文后这两组数字**没有重跑**。所以**不要**说「当前样例命中率 100%」，
   稳妥说法是「三份真实材料 91 条引用命中 79 条，86.8%」。
2. 材料风险 `risk_score` 由服务端从 claims 聚合（纯函数，与模型采样无关，两场恒等）；
   临场表现 `performance.score` 由模型出分，**有波动**。我们只声称「结构可重复、材料侧分数可重复、锚点可复检」，
   不声称输出逐字可重复。完整论证见 `docs/technical-doc.md` §4（可复现性论证）与 §5（评测与数据）。

> 单测与 fixture 数以**提交当天 `npm test` / `npm run test:fixtures` 的实测值**为准；
> 本表是 2026-11-16 的快照，若提交前数字变化，改这张表即可，不要改历史 AI 日志里的旧数。

---

## 运行期模式切换（演示 ⇄ 真实）

页面顶部有分段切换条，**不重启服务**即可换模式：

| 档位 | 评委发言 | 上传 | 需要 key |
|---|---|---|---|
| 演示 · 零 key 回放 | 从 `fixtures/llm/` 顺序回放 | 只收内置样例 | 否 |
| 真实 · 实时模型 | 走 DeepSeek 实时生成 | 接受任意合法 PDF/DOCX | 是 |

它是**唯一总闸**：切换模式会同时改变「上传是否只收内置样例」和「评委发言走回放还是真模型」——服务端两道闸都从同一处取判定，所以不会出现"界面切了、服务端没切"的错位。

启动默认值仍由 `MOCK_LLM` 决定（`npm run demo` → 演示；`npm run dev` → 真实）。运行期覆盖只存在进程内存里，**重启后回到 `MOCK_LLM` 的默认值**。切换后页面会自动整页刷新，让角标、上传禁用态、报告页脚注都按新模式重渲。

> 切到真实模式但没配 `DEEPSEEK_API_KEY` 时，模型调用会返回 `E_NO_KEY` 并提示切回演示模式——不会静默失败，也不会拿假数据冒充真结果。

## 真实模式（可选）

```bash
# .env.local
MOCK_LLM=0
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
MODEL=deepseek-chat
```

## 环境要求

| 项 | 值 |
|---|---|
| Node | **≥ 22.13**（本仓库在 v24.18 上验证；`node:sqlite` 需要 ≥22.5） |
| npm | ≥ 10 |
| 系统 | Windows / macOS / Linux 均可，**无需 MSVC、node-gyp、Python** |

## 为什么没有原生依赖（工程约束）

三个决定都是为了"评委 `npm i` 一次成功"：

1. **数据库用 Node 内置 `node:sqlite`**（`DatabaseSync`），不装 `better-sqlite3`——后者是原生模块，缺预编译就落到 MSVC 编译。业务层只经过 `lib/db.ts` 的 `q.*` 出口，换驱动只改这一个文件。
2. **PDF 用 `pdfjs-dist@5.4.149`，只做文本提取不渲染**——6.x 的可选依赖 `@napi-rs/canvas` 会拉一个 28MB 的原生 `.node`。本产品不需要渲染，所以用 `scripts/polyfill-canvas.mjs` 补 `DOMMatrix / Path2D / document` 的最小替身即可（运行时会出现一条 `Cannot load "@napi-rs/canvas"` 的提示，属预期，不影响结果）。**注意：不要用 `--omit=optional` 省这个包**（见上文实测对比，那会让 Next 在运行期联网下 swc）。
3. **DOCX 用 `mammoth`（纯 JS），不引入 `officeparser`**——后者捆绑 `tesseract.js`（WASM OCR），为"顺手支持 PPTX"背一个 OCR 引擎不划算。**PPTX 明确不支持**。

## 依赖清单

| 包 | 用途 | 备注 |
|---|---|---|
| `next@15.5.28` | 框架（App Router） | **锁 15，不升 16** |
| `react@19` / `react-dom@19` | UI | — |
| `zod@4` | LLM 输出契约校验 | — |
| `pdfjs-dist@5.4.149` | PDF 逐页取文本 | `--omit=optional` |
| `tailwindcss@4` | 样式 | 配色 token 在 `app/globals.css` |

## 目录

```
app/            页面与 API 路由（路由层只做 HTTP，业务全在 lib/）
lib/            parse / locator / state / report / llm / mock（核心是纯函数）
fixtures/       llm 回放剧本 + demo 内置样例
scripts/        spike-parse / record-fixtures / eval / test-fixtures
docs/ai-logs/   每个功能的 AI 协作记录（含 Bug 与修复过程）
```

## 已知不支持

- **扫描版（图片型）PDF**：不做 OCR，会返回可读错误提示
- **PPTX**：不支持，请另存为 PDF 或 DOCX
- **docx 没有"页"**：走 `flow` 模式，用 `§章节 + 逐字引用` 定位（这是设计决定，不是缺陷）

## 自检

```bash
npm run build           # 必须过
npm run test            # 纯函数单测（2026-11-16 实测 467 个全绿）
npm run test:fixtures   # 用当前 schema 校验全部回放剧本（51 项 / 0 失败；三层：zod / 定位机检 / 评委锚点去重）
npm run demo            # 零 key 起服务（MOCK 回放，自动播种内置样例）
```

## 提交历史说明（关于首个 commit）

本仓库的**第一个 commit**（`chore: scaffold next15 + node:sqlite schema + pure-function core`）承担的是**阶段 0 的脚手架 + 数据模型 + 纯函数层 + 单元测试**四件事的一次性落地。

这一形态**接近官方规则里禁止的"一次性提交"**，所以在此如实说明，而不是靠改写历史掩盖：

- 该 commit 对应的是一场**完整的 AI 协作会话**（记录见 `docs/ai-logs/20261030-scaffold.md`，其中含 7 条真实 Bug 与修复过程）；
- 它落地的是"地基"（8 张表 + 6 个纯函数模块 + 46 个单测），而非任何一个可见功能；
- **此后严格一功能一 commit**，每个 commit 对应一次 AI 会话或一个功能模块；
- 项目从零构建，**未复用任何既有项目代码**。

## 参考与原创声明

- **原创性**：本作品从零构建。开发过程中参考过若干本地既有项目的**架构思路**，但**未复制任何代码**；所有源码均为本次比赛中新写。
- **依赖**：见上方「依赖清单」，均为公开开源库。
- **许可证**：MIT，见 `LICENSE`。
