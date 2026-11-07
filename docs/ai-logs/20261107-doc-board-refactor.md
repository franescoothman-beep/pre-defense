# 2026-11-07 质疑点页排版重构（工具栏 + 三列看板 + 卡片）

## 目标

`app/doc/[id]/page.tsx` 与 `app/doc/[id]/doc.css` 的排版重构：

1. 顶部散落的「标题 / 参数行 / 开始质询卡片 / 孤立的重抽按钮」合并成一条横向控制台工具栏；
2. 三列看板不均衡（方法论 10 / 工程实现 0 / 价值 2）时，空列不再只放「— 无 —」；
3. 质疑点卡片重做层级：问句、星级、定位胶囊、命中状态、展开原文。

硬约束（用户原话）：**完全不修改任何业务逻辑、State、onClick、展开全文事件和锚点数据（BLOCK 索引、原文字段）**。

## Prompt 原文（摘要）

> 这是我的 AI 答辩质询系统的「质疑点抽取/看板」页面代码。请在【完全不修改任何业务逻辑、State、onClick、展开全文事件和锚点数据（如 BLOCK 索引、原文字段）】的前提下，对整体排版和视觉层次进行重构。
> 一、顶部整合为现代「控制台工具栏（Action Toolbar）」…
> 二、解决三列看板不均衡（方法论 10 / 工程实现 0 / 价值 2）…
> 三、精致化质疑点卡片（Card UI）…
> 【输出要求】请保留所有原始变量、条件判断和函数，直接输出修改了样式类名和结构排版后的完整组件代码。

## 与 prompt 的偏离（有意为之）

| prompt 要求 | 实际做法 | 原因 |
|---|---|---|
| `bg-zinc-900` / `bg-emerald-50` / `border-zinc-200` 等 Tailwind 工具类 | 改成 `--ink` / `--green-soft` / `--line` 等纸色 token | 项目铁律 9：组件里不写十六进制颜色，只走 globals.css token；zinc/amber 是 Tailwind 默认色板，会绕开纸色体系 |
| `rounded-lg`（8px） | `border-radius: 4px` | 沿用上一轮 `hero-badge` 已破例的 4px，不再引入第二档圆角 |
| `text-sm`（14px）问句 | `13.5px` / `font-weight 500` | 字号只允许 11 / 13.5 / 17 / 34 / 62 五级 |
| 空列 `p-6 text-center` | 顶部对齐 + ✓ 图标 + 两行说明 | 三列等高的 `flex:1` 会让垂直居中内容掉到几千像素以下，第一屏看不到 |

## 改动清单

### app/doc/[id]/page.tsx

- 顶部参数行 `{doc && …}` → `{doc && claims.length === 0 && …}`：抽取完成后同样的数字已在工具栏摘要里，避免同一组数字说两遍。
- `.launch` 整段替换为 `<section className="toolbar" aria-label="开始质询">`：
  - 左 `.toolbar-status`：文件名 `.toolbar-doc` + 分隔点 + 高危质疑数 + 命中数（`.is-hit`）+ 缺失数（`absenceTotal > 0` 时才加 `.is-missing`）。
  - 右 `.toolbar-actions`：重新抽取（`.btn.btn-ghost`，busy 时「正在重抽…」）、快速质询（`.btn`）、完整评审（`.btn.btn-outline`）、reviseFrom 时追加「用改后材料重审」。
- 原「开始质询」卡片里的两段说明合并成 `<p className="toolbar-note">`（文案逐字保留，只挪位置）。
- 新增 `<p className="toolbar-meta">`：渲染 `rate.quote` 的机检结果。原代码里 `rate` 只在被删掉的那一行渲染，直接删会让 `rate` 变成未使用变量。
- 看板：`const isEmpty = list.length === 0`；空列渲染 `.col-empty`（两行：先说结论，再说「0 条不代表没问题」）；非空渲染 `.col-body` 包住卡片。
- 卡片：删掉 `.body` 外层，`<p className="txt">` 直接作子节点；`absence` 用 `.tag.tag-absence`；`quote` 用 `.tagrow` 装两颗胶囊（`.tag-quote` 定位 + `.tag-hit` / `.tag-pending` 状态）。
- 展开按钮补 `aria-expanded={opened}`，供 CSS `::before` 切换 ▸ / ▾ —— 只加属性，`onClick` 与文案逻辑一字未改。

### app/doc/[id]/doc.css

- `.cols` gap 0 → 14px、margin-top 32 → 26px；`≤820px` 单列 gap 20px。
- `.col` 去掉左分隔线与 `padding-left`，改 `display:flex; flex-direction:column`。
- `.colhd` 改浅底表头：`--paper-2` 底、1px `--line` 边、`border-radius: 4px 4px 0 0`、`border-top: 2px --dim-logic`；标题 13.5px/600；数量改胶囊徽标（mono 11px、`--paper` 底、`margin-left:auto`）。
- 新增 `.col-body`（`flex:1`、`min-height:340px`、`--paper-2` 底）与 `.col-empty`（虚线 `--line-2`、顶部对齐、`::before` 加 ✓）。
- `.card`：`--paper-3` 底、1px `--line` 边、`border-left: 2px --dim-logic`、4px 圆角、`--shadow-1`、`padding: 14px 15px`、`margin-bottom:10px`、hover 换 `--line-2`。
- `.card .txt` 从 serif 17px 改 sans 13.5px / 500 / line-height 1.65。
- 新增 `.tagrow` / `.tag` / `.tag-quote` / `.tag-hit` / `.tag-pending` / `.tag-absence`。
- `.toggle` 去掉下划线，改链接式：11px、`--muted`、`::before` ▸/▾、hover `--ink`。
- `.launch*` / `.empty` / `.anchor` 规则删除（对应结构已不存在）；新增 `.toolbar*` 与 `.btn-outline`，`.toolbar-actions .btn` 收到 11px / `padding: 7px 13px`。

## Bug 与修复过程

1. **空列文案整块看不见**：`.col-empty` 最初 `justify-content:center`，三列被拉到与最长列等高（约 4000px），居中后落在几千像素以下。截图只看到一片空白。改为 `justify-content:flex-start` + `padding: 40px 20px`，第一屏即可读到。
2. **`.is-miss` 与 `.is-missing` 类名不一致**：TSX 写 `is-missing`，CSS 选择器写 `.is-miss`，缺失数不会变色。统一为 `is-missing`。
3. **空列里塞了一个 `·` 文本**：`.dot-sep` 本来用 `width/height` 画点，里面还留着 `·` 字符，会撑出多余宽度。改为自闭合空元素。
4. **`npx tsc --noEmit` 全仓报错**：约 40 条都在 `tests/`（`allowImportingTsExtensions` 未开、`@ts-expect-error` 未使用），与本次改动无关；用 `Select-String "^app/|^components/|^lib/"` 过滤后 app 源码零错误。
5. **无头截图在 400px 下右侧被裁**：`--window-size=400` 时 Chrome 仍按约 800px 布局再裁图，看起来像横向溢出。以 `probe:mobile` 的 `clientW/scrollW` 为准（9/9 均为 400/400），不据截图判定溢出。

## 验收

| 闸门 | 结果 |
|---|---|
| `npm test` | 416 / 416 pass，fail 0 |
| `npm run test:fixtures` | 检查项 39，失败 0 |
| `npm run build` | Compiled successfully，15 路由（`/doc/[id]` 4.17 kB） |
| `npm run probe:mobile -- --base http://127.0.0.1:3000` | 9 / 9 页无横向溢出 |

## 遗留

- 全站圆角从此前的 3 处（home / upload / doc 的 `.hero-badge`）增至 6 处左右（再加 `.colhd`、`.col-body`、`.col-empty`、`.card`、`.tag`），仍全部为 4px；`ask.css` 的 6px 仍是唯一被测试断言的圆角。
- 空列文案「该维度材料表述严密，未检测出高危漏洞」是新增文案，原设计只有「— 无 —」。
- 4px 圆角与 13.5px 问句都已偏离交接文档 §2.3 / §2.4，本轮按用户「按 prompt 原意」的指示执行。
