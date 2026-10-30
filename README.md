# 预演（Rehearsal）· 质询台

> 上传论文 / 项目文档 / 简历 → 三位 AI 评委轮番质询 → 答辩风险报告。
> **每条结论都能点回原文那一句**（锚点 + quote 逐字机检，未命中就灰显，绝不隐藏）。

## 10 分钟复现（零 key、零网络）

```bash
git clone <本仓库地址> && cd rehearsal
npm i --omit=optional        # 关键：不装原生 canvas，见下方「为什么没有原生依赖」
cp .env.example .env.local   # 默认 MOCK_LLM=1，不需要任何 API key
npm run demo                 # 起服务，浏览器打开 http://localhost:3000
```

然后按界面走：**选内置样例 → 开始质询（quick 档 3 位评委各 1 问）→ 出报告 → 复练**。
全程约 5–8 分钟，**不需要 API key 也不需要联网**。

> 演示模式下界面右上角常驻 `MOCK 演示模式` 角标；上传页只放开内置样例（上传自己的文件会被置灰拦截并说明原因）。这不是限制，是为了让回放与场景严格对齐。

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
2. **PDF 用 `pdfjs-dist@5.4.149` 且 `--omit=optional`**——6.x 的可选依赖 `@napi-rs/canvas` 会拉一个 28MB 的原生 `.node`。本产品只需要**文本提取**，不需要渲染，所以用 `scripts/polyfill-canvas.mjs` 补 `DOMMatrix / Path2D / document` 的最小替身即可（运行时会出现一条 `Cannot load "@napi-rs/canvas"` 的提示，属预期，不影响结果）。
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
npm run test            # 纯函数单测
npm run test:fixtures   # 用当前 schema 校验全部回放剧本
```
