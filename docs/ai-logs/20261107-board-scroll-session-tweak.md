# 2026-11-07 · 看板定高滚动 + 质询台去重标题 + 站点图标

## 目标

两处局部微调（用户明确「不修改任何变量、方法和事件」）：

1. 质疑点看板三列定高、列内独立滚动、细滚动条；某列 10 张卡、另一列为空时底部严整对齐。
2. 质询台对战页去掉提问卡内重复的评委姓名大标题；强化 BLOCK 原文溯源区块；把「MOCK 回放／未调用模型」这类测试色彩文案改成严谨表述。

外加一件事：修掉 Next dev overlay 角标上的「1 Issue」。

## Prompt 原文

> 请帮我针对当前两个界面的 CSS/排版做两处局部微调（不修改任何变量、方法和事件）：
>
> 1. 质疑点看板页 (Checkpoints)：
>    - 给三列看板容器（方法论 / 工程实现 / 价值与创新）设置最大高度限制与列内独立滚动：统一外层高度为固定高度（例如 h-[680px]），给每一个包含卡片的容器加上 overflow-y-auto 和自定义细滚动条。
>    - 确保当某一列有 10 张卡片、另一列为空时，页面底部高度始终严整对齐，不会出现右侧大面积空洞的断层。
>
> 2. 质询台对战页 (Session)：
>    - 移除提问主卡片内重复出现的"陈评委 证据"大标题（因为顶部评委席已处于激活高亮状态）；
>    - 强化下方的原文溯源区块（BLOCK 区块）：背景改为非常淡的暖白/浅灰，左侧加上 3px 的警示色强调条（border-l-3 border-amber-500），突出 RAG 事实锚点感；
>    - 隐藏或弱化所有"MOCK 回放、未调用模型"等带有测试色彩的文本，将其文案规范为严谨的"系统审计日志已同步"。

后续追加：「issue改了吗」→ 指 dev 角标那条 issue（缺 favicon）。

## 动手前的边界勘察

先查测试，确认哪些能改、哪些不能碰：

- `tests/mock.test.ts:89-96` 硬性要求 `components/MockBadge.tsx` 同时包含「录制回放」「非实时模型输出」「仅支持内置样例」三句 → **顶部常驻 MOCK 角标不能动**，只能改页面正文文案。
- `tests/cursor.test.ts`：`app/session/[id]/session.css` 只许有 `cursor-blink` 一个 `@keyframes`。
- `tests/scan.test.ts:98-106`：`app/session/[id]/ask.css` 只许 1 处 `border-radius` 且必须 6px 在 `.answer-input`。
- `tests/scan.test.ts:25-62`：scan-sweep 2.6s linear、`.is-settled` 用 `animation-iteration-count:1`、`.is-swept` 才 `animation:none`。
- 无任何测试断言 `doc.css` 的 `.cols/.col-body` 高度或 overflow，也无测试断言 session 页的 `.turn-head/.turn-name` 结构 → 这两处可自由改。

## 改动

### `app/doc/[id]/doc.css`（+31/−6）

- `.cols`：加 `height: 680px`；`@media (max-width: 820px)` 内加 `height: auto` —— 单列布局不该出现嵌套滚动。
- `.col`：加 `min-height: 0`（否则 flex 子项不会收缩，`overflow` 永远不生效）。
- `.colhd`：加 `flex: none`，保证表头不被压缩。
- `.col-body`：`min-height: 340px` → `0`，新增 `overflow-y: auto`、`overscroll-behavior: contain`、`scrollbar-width: thin`、`scrollbar-color: var(--line-2) transparent`。
- `.col-body::-webkit-scrollbar`：6px 宽；track 透明；thumb `var(--line-2)` + `border-radius: 3px`；hover `var(--muted)`。
- `.col-empty`：`min-height: 340px` → `0`，同样加 `overflow-y: auto`，与有卡片的列共享同一高度基线。

### `app/session/[id]/page.tsx`（+20/−17）

- `.turn` 不再渲染 `.turn-head > .turn-name + .turn-dim`，改为在容器上挂 `aria-label={currentPersonaName + ' · ' + DIM_CN[currentDim]}`，评委身份由顶部高亮席位表达；仅当是追问时保留 `.turn-head` 里的 `.turn-followup` 徽标。
- `scan-head` 的「本步」列：`doneInfo?.meta?.mock || meta.replay ? '系统审计日志已同步' : …` —— 原来「回放」「重播」两个分支合并成一句。
- `chat-status`：`doneInfo.meta` 存在时照旧显示「发言结束 · 用时 Nms · 转 model」，否则显示「发言结束 · 系统审计日志已同步」；原「发言结束（MOCK 回放，未调用模型）」与「发言结束（重播，未调用模型）」两句删除。

### `app/session/[id]/ask.css`（+5/−12）

- `.scan`：`background` 由 `var(--paper-3)` 改 `var(--paper)`（更暖白，贴近卡片）；新增 `border-left: 3px solid var(--dim-logic)`。
- 删除 `.scan.is-settled::after`（原来是 2px `var(--line-2)` 灰竖线）：它会叠在新锚点条上把赭石盖成灰，原位留注释说明原因。

### `app/session/[id]/session.css`（+2/−17）

- 删除 `.turn-name` 与 `.turn-dim` 两条规则（已无引用，不留死代码）。
- `.turn-head` 注释改为「只在追问时出现」，`margin-bottom` 10px → 8px。

### `app/icon.svg`（新增，10 行）

- Next 约定式图标路由：暖纸底 + 纸白内框 + 朱批竖笔 + 四行墨色文本块，纯几何、不依赖字体。

## Bug 与修复过程

1. **列高设了但不滚动**：先只给 `.col-body` 加 `overflow-y: auto` 无效 —— flex 子项默认 `min-height: auto` 会被内容撑开。补 `.col { min-height: 0 }` 与 `.colhd { flex: none }` 后才真正生效。
2. **空列被拉到几千像素以下**：`.col-empty` 沿用 `justify-content: center` 时，在 680px 定高容器里内容随 10 卡列一起被拉伸，截图只剩一片空白。改为顶部对齐（`flex-start`）后恢复正常。
3. **灰线盖住新锚点条**：`.scan.is-settled::after` 是 2px、`left: 0`、`top: 0; bottom: 0`，正好压在新加的 3px 左边框上。删掉这条伪元素而不是调层级 —— 锚点条应当常驻，不该在动画结束后变灰。
4. **`favicon.ico` 一直 404**：`.get('/favicon')` 报 issue 的根因是 `app/layout.tsx` 只有 `title/description`，没有 icon 声明。加 `app/icon.svg` 后 Next 自动注入 `<link rel="icon" href="/icon.svg?…" type="image/svg+xml" sizes="any"/>`。
5. **dev issue 计数是进程级的**：加完 icon 后不重启，角标仍显示 1。必须 `job_kill` 旧 demo 再重启，overlay 才会重新统计。
6. **`/favicon.ico` 仍 404**：SVG 已覆盖现代浏览器且不再计 issue；老浏览器要 `.ico` 得另放二进制文件，本轮未做（见遗留）。

## 验收（四闸门）

| 闸门 | 命令 | 结果 |
|---|---|---|
| 单测 | `npm test` | 416 pass / 0 fail |
| 回放剧本 | `npm run test:fixtures` | 39 检查项 / 0 失败 |
| 构建 | `npm run build` | ✓ Compiled successfully，15 路由 + `/icon.svg` 静态资源 |
| 移动端 | `npm run probe:mobile -- --base http://127.0.0.1:3000` | 9 / 9 无横向溢出（clientW=scrollW=400） |

视觉复核（Edge headless，1440×1000 与 1440×1500）：质疑点页三列同高、方法论列内出现细滚动条、空列虚线框与两侧齐平；质询台页问题卡直接进正文、没有重复姓名，BLOCK 区块为暖白底 + 左侧赭石粗条，状态行为「发言结束 · 系统审计日志已同步」。角标截图对比：修复前带数字 1，修复后只剩 N。

## 契约偏离记账

- **没用 amber-500**：项目无 amber token，组件里也不许写十六进制色。3px 强调条用最接近的既有维度色 `--dim-logic`（赭石 #8c5b3f）。
- **滚动态 thumb 用了 `border-radius: 3px`**：这是本轮第四处圆角（此前已有 hero-badge 三处 4px、ask.css 的 6px、报告页散点 50%）。浏览器原生滚动条不写圆角会显得突兀，属有意取舍。
- **顶部 MOCK 角标文案未动**：受 `tests/mock.test.ts` 保护，只改页面正文。

## 遗留

- `/favicon.ico` 仍 404；如需兼容老浏览器，得补一份 32×32 的 `.ico` 二进制。
- 列高写死 680px，未按视口做 `min(680px, 70vh)` 之类的自适应；若后续评委用超小屏笔记本，可考虑改为 `clamp()`。
- `_preview/` 下仍有排查用的 CDP 脚本与截图（未入库）。

## commit

`62a0d28` style(doc,session): 看板定高列内滚动、质询台去重复标题并强化原文锚点，补站点图标
5 files changed, +62 / −52
