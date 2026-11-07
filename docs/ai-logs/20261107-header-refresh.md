# 2026-11-07 标题区（Header）重构 —— 两轮：先合规子集，后按用户「原意」放开

## 目标

用户拿了一份外部 prompt，要求重构 Header 标题区：去掉末尾红色句号、标题改无衬线粗体并缩到 24–30px、加胶囊徽标、正文下划线换浅底高亮、副标题降到 14px。

**第一轮**按项目既有契约只做了合规子集（详见下）；用户看完后说「按照原意优化一下吧」，于是**第二轮**按 prompt 原意放开：标题改无衬线粗体、删除句号、徽标加 4px 圆角、副标题降到 13.5px 且改次要色。

## Prompt 原文（用户）

> 请帮我重构当前组件的 Header 标题区样式（使用 Tailwind CSS 或等效 CSS 类名）。
> 【严格约束】：
> 1. 保持现有所有文案、React State、props、路由跳转事件完全不变，不增删任何底层逻辑。
> 2. 仅调整字体字号、间距、对齐方式与文字装饰。
>
> 【要解决的视觉问题】：当前页面标题（如「预演。」、「质疑点。」）使用过大的衬线体且带有一个突兀的红色句号，悬浮在页面顶部显得非常空旷脱节，下方的文字下划线也像未做完的超链接。
>
> 【优化目标】：1. 标题现代化…… 2. 消除正文视觉杂音……
> 请直接输出重构后的 Header JSX 代码。

中途两次指令：

> 走推荐的那条路

> 按照原意优化一下吧

## 第一轮：合规子集（commit `a7e83a3`）

当时判断 prompt 与已定稿契约有三处冲突，因此只做了不破坏契约的部分：

| prompt 要求 | 撞上的约束 |
|---|---|
| Tailwind 工具类 `text-zinc-900` / `bg-amber-50` / `rounded` | 交接文档 §9 明列「❌ 不做」；`zinc`/`amber` 是 Tailwind 默认色板，绕开 `--paper`/`--ink`/`--red` 全部 token |
| 字号 `text-2xl`/`text-3xl`/`text-xs`/`text-sm` | §2.3：全站只有 11 / 13.5 / 17 / 34 / 62 五级 |
| 胶囊徽标 `rounded` | §2.4：全站只许 1 处圆角（`.answer-input` 6px） |

第一轮只做了：字距收紧、句号降权（保留字符）、下划线换浅朱底、三页加直角徽标、间距调整。

## 第二轮：按原意放开（commit 见下）

用户明确要「原意」后，把第一轮留下的三处折中全部按 prompt 落地。**注意：这不只是样式改动，是改规格**——全站圆角从 1 处变 3 处、标题字族从衬线变无衬线、删掉三个文案字符。

### 1. `app/home.css`

```css
.hero { padding-bottom: 28px; }           /* 36 → 28 */

.hero-badge {                              /* 新增：胶囊徽标 */
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--muted);
  background: var(--paper-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 8px;
  margin-bottom: 14px;
}

.wordmark {                                /* 62px 衬线字标 → 34px 无衬线粗体 */
  font-family: var(--font-sans);
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.3;
  margin: 0;
  color: var(--ink);
}

.tagline {                                 /* 17px 衬线 → 13.5px 无衬线、次要色 */
  font-family: var(--font-sans);
  font-size: 13.5px;
  color: var(--muted);
  line-height: 1.75;
  margin: 14px 0 0;
  max-width: 62ch;
}

.tagline b {                               /* 细下划线 → 浅朱底高亮 */
  color: var(--ink);
  font-weight: 600;
  background: var(--red-soft);
  padding: 0 3px;
}
```

### 2. `app/doc/[id]/doc.css` 与 `app/upload/upload.css`

同样三件事：加 `.hero-badge`（4px 圆角）、`.wordmark` 换 `--font-sans` + 700 + 34px、`.lede` 换无衬线 13.5px + `--muted` + `max-width: 62ch`。

### 3. TSX：删句号 + 加徽标

```tsx
// app/page.tsx:32-33
<div className="hero-badge">PHASE 01 · 答辩准备</div>
<h1 className="wordmark">预演</h1>

// app/upload/page.tsx:224-225
<div className="hero-badge">STAGE 01 · 材料接入</div>
<h1 className="wordmark">预演</h1>

// app/doc/[id]/page.tsx:229-230
<div className="hero-badge">CHECKPOINT · 漏洞透视</div>
<h1 className="wordmark">质疑点</h1>
```

`.dot` 的样式规则也随之删除（三处页面 CSS 里的 `.wordmark .dot` 已无 JSX 引用）。

## 与硬约束的偏离（必须记账）

| 约束 | 原状 | 现在 |
|---|---|---|
| §2.4 全站只许 1 处圆角，6px，必须在 `.answer-input` | 1 处（`ask.css:173` 6px） | **3 处**：`home.css:50` 4px、`upload.css:44` 4px、`doc.css:39` 4px、外加报告页既有散点 50%，`ask.css` 6px 不变 |
| §2.3 字号只有五级 | 首页标题 62px | 62 → **34px**（仍在五级内，未新增档） |
| 文案零改动 | 标题为「预演。」「质疑点。」 | **删除了 3 个「。」字符** |
| 测试 `scan.test.ts:98-106` 只卡 `ask.css` | 不受影响 | ✅ 仍 1 处 6px |
| 测试 `bench.test.ts:105-108` 只卡 `Bench.css` | 不受影响 | ✅ 无圆角 |

**没有任何测试覆盖 home/upload/doc 的圆角**，所以 `npm test` 依然 416/416 全绿——**测试变绿不代表契约没破**。这条要写进后续检查清单：若将来要恢复「全站单圆角」，改这三处 + 三处 TSX 即可。

## Bug 与修复过程

无功能性 Bug。一处判断修正值得记：第一轮曾想把 `.tagline b` 的下划线换成 `font-semibold` 加粗，读代码发现它本来就是 `font-weight: 600`——只加粗不产生任何视觉变化，真正的解法是换「装饰形式」（细线 → 浅底）。

第二轮删句号后，三个 CSS 文件里的 `.wordmark .dot` 规则成为死代码，已一并删除（grep 确认全站无 `className="dot"` 残留）。

## 四闸门

| 闸门 | 结果 |
|---|---|
| `npm test` | 416 / 416 |
| `npm run test:fixtures` | 39 / 39 |
| `npm run build` | Compiled successfully，15 路由 |
| `npm run probe:mobile --base 3000` | 9 / 9 页 `clientW = scrollW = 400` |

视觉自检（Edge 无头 1440px，`--virtual-time-budget` 6000）：首页标题从「宋体 62px + 朱红句号」变为「黑体 34px 粗体」，副标题收紧到 13.5px 次要色，徽标在最上方形成「阶段 → 标题 → 说明」三级结构；材料页同样三级结构，标题与下方 `.stat` 元数据行之间的呼吸比改前紧。

## 遗留问题

- **录屏口径需重看**：副标题 17 → 13.5px 后，1080p + 浏览器 125% 下约为 17px 等效，仍在可读范围；但这是把 v2.1.16 为「正文仅 13.5px」做的放大又退了回去——**首页副标题**退了，材料页卡片正文仍 17px，两者现在不一致，需目视确认能否接受。
- **标题字族变更影响品牌感**：宋体字标是方向 E 的一部分，改无衬线后与「朱批 / 档案」气质有落差。若后续要做录屏封面或海报，字标可能仍需衬线版本。
- 徽标文案（`PHASE 01 · 答辩准备` / `STAGE 01 · 材料接入` / `CHECKPOINT · 漏洞透视`）为新增展示文案，属我按页面语义拟的，可随时改词。

## commit

- 第一轮（合规子集）：`a7e83a3` `style(header): 标题区收敛字距、句号降权、正文下划线改浅朱底高亮，三页补阶段徽标`
- 第二轮（按原意放开）：见下一次提交
