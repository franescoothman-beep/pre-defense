# 2026-11-07 标题区（Header）视觉重构

## 目标

用户拿了一份外部 prompt，要求「重构 Header 标题区样式」：去掉红色句号、标题改无衬线粗体并缩到 24–30px、加胶囊徽标、正文下划线换浅底高亮、副标题降到 14px。

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

随后用户选定（原话）：`走推荐的那条路`

## 判断：原 prompt 有三处与已定稿契约冲突

| prompt 要求 | 撞上的约束 | 结论 |
|---|---|---|
| Tailwind 工具类 `text-zinc-900` / `bg-amber-50` / `rounded` | 交接文档 §9 明列「❌ 不做」；铁律 9 要求组件内不出现十六进制 | Tailwind 已安装（`globals.css:1` 有 `@import 'tailwindcss'`，`postcss.config.mjs` 挂 `@tailwindcss/postcss`），但 `zinc`/`amber` 是默认色板，会绕开 `--paper`/`--ink`/`--red` 全部 token |
| 字号 `text-2xl`/`text-3xl`/`text-xs`/`text-sm` | §2.3：全站只有 11 / 13.5 / 17 / 34 / 62 五级 | 24/30/12/14px 都是加第 6 级 |
| 胶囊徽标 `rounded` | §2.4：全站只许 1 处圆角（`.answer-input` 6px） | 第二个圆角 = 改契约 |
| 副标题降到 14px | v2.1.16 刚把材料页正文 13.5 → 17px，就为解决「1080p 正文仅 13.5px」 | 属于回退刚修好的问题 |

另有一处 prompt 自身矛盾：要求「文案完全不变」同时要求「移除末尾红色句号」——句号是 JSX 里的文案文本（`<span className="dot">。</span>`），删字符就是改文案。

## 实际改动（合规子集）

只解决用户点出的三个真问题，不引入新字号档、不加圆角、不引入 Tailwind 工具类。

### 1. `app/home.css`

- `.hero` `padding-bottom` 36 → **28px**（首屏过空的根因之一是这段断口过大）
- `.wordmark` `letter-spacing` 0.22em → **0.12em**，`line-height` 1 → **1.1**（字距收紧后不再「飘成两座孤岛」）
- `.wordmark .dot` `color: var(--red)` → **`var(--muted)`**：句号文案保留，降权到次要色，不再抢标题
- `.tagline` `margin-top` 36 → **18px**，`max-width` 56ch → **62ch**（与 `.lede` 对齐）
- `.tagline b`：删掉 `border-bottom: 1px solid var(--red-line)`，改 **`background: var(--red-soft)` + `padding: 0 2px`** —— 用浅朱底微高亮替代细下划线，等价于 prompt 想要的 `bg-amber-50`，但走 token、不加圆角
- 新增 `.hero-badge`：等宽 11px、`--muted` 字、`--paper-2` 底、1px `--line` 边框、`padding: 3px 8px`、直角（无 `border-radius`）

### 2. `app/doc/[id]/doc.css`

- 新增同款 `.hero-badge`
- `.wordmark` `letter-spacing` 0.2em → **0.12em**
- `.wordmark .dot` 同样降权到 `var(--muted)`
- `.lede` 补 **`max-width: 62ch`**（原先无上限，长句在大屏横向拉扯）

### 3. `app/upload/upload.css`

- 新增同款 `.hero-badge`
- `.wordmark` `letter-spacing` 0.24em → **0.12em**，`line-height` 1 → **1.1**
- `.wordmark .dot` 降权到 `var(--muted)`

### 4. TSX 只加一个展示节点（三处）

- `app/page.tsx:32` 加 `<div className="hero-badge">PHASE 01 · 答辩准备</div>`
- `app/doc/[id]/page.tsx:229` 加 `<div className="hero-badge">CHECKPOINT · 漏洞透视</div>`
- `app/upload/page.tsx:224` 加 `<div className="hero-badge">STAGE 01 · 材料接入</div>`

**未动**：所有 state / hooks / fetch / `data-*` / 事件处理 / 路由 / 任何已有文案字符（含那个句号）。

## 未采纳的三项（附理由）

1. **标题改无衬线粗体** —— 宋体大字 + 朱红句号是方向 E 的 wordmark（字标），换 `font-sans` 就不是「预演」这张脸了。
2. **标题降到 24–30px** —— 不在五级阶梯内。若真要收敛体量，可行方案是首页 62 → 34px（阶梯内，且与上传页/材料页一致），但用户未选。
3. **副标题降到 14px** —— 会吃掉上一轮为 1080p 录屏做的正文放大。要「更轻」应调颜色而不是调字号。

## Bug 与修复过程

无。改动纯 CSS + 三个静态节点插入，四闸门一次通过。

一处**判断修正**值得记：最初打算把 `.tagline b` 的下划线换成 `font-semibold` 加粗，读代码发现 `.tagline b` 本来就已是 `font-weight: 600`——只加粗不产生任何视觉变化，所以真正的解法是换「装饰形式」（细线 → 浅底），不是换「字重」。

## 四闸门

| 闸门 | 结果 |
|---|---|
| `npm test` | 416 / 416 |
| `npm run test:fixtures` | 39 / 39 |
| `npm run build` | Compiled successfully，15 路由 |
| `npm run probe:mobile --base 3000` | 9 / 9 页 `clientW = scrollW = 400` |

视觉自检（Edge 无头 1440px，`--virtual-time-budget` 6000–7000）：首页徽标 + 标题 + 高亮三处变化都出来了；标题字距收紧后与正文左缘的关系更紧；上传页与材料页的徽标同款，三页形成一致的「阶段标记」语言。

## 遗留问题

- 首页标题仍 62px（用户未选 34px 方案）。若录屏时觉得过大，改一个数即可，属阶梯内调整。
- 徽标文案（`PHASE 01 · 答辩准备` / `CHECKPOINT · 漏洞透视` / `STAGE 01 · 材料接入`）是我按页面语义拟的，属于新增展示文案，用户可随时改词。

## commit

待提交。
