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

### MOCK 模式的三个前提（务必知道，否则会误判为故障）

1. **只允许内置样例**：`fixtures/demo/` 提供预置材料。`MOCK_LLM=1` 下上传自己的文件会被**置灰拦截**并提示原因——因为回放剧本与样例严格对应，换成你的材料必然错位。
2. **序号驱动，不是内容驱动**：同一场会话内按 `phase + seq` 递增回放，所以**回答顺序固定**；`inputHash` 只做告警，不参与路由。
3. **角标常驻**：全局 header 与报告页脚注都标注了 MOCK 模式。**不标等于默认在编数据**，所以必须标。

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
npm run test            # 纯函数单测（414 个）
npm run test:fixtures   # 用当前 schema 校验全部回放剧本（三层：zod / 定位机检 / 评委锚点去重）
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
