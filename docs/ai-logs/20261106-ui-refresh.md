# 2026-11-06 全站 UI 精调（视觉升级，功能零改动）

## 目标

按 `UI优化-新会话交接文档.md` §7 规定顺序，逐文件对全站做一次「纯视觉与排版」升级：
留白均匀、分隔线变轻、层级清楚、容器收窄、阴影统一。

硬约束（任一违反即返工）：

- 只写手写 CSS，不用 Tailwind 工具类
- 颜色只走 `app/globals.css` 的 token，组件里不出现十六进制
- 字号只有 11 / 13.5 / 17 / 34 / 62 五级
- 全站唯一圆角：`ask.css` 的 `.answer-input` 6px
- 不新增 `animation` / `@keyframes`，四处动效账不动
- 不动 TSX、state / hooks / fetch / `data-*`、锚点跳转、文案与数字口径
- 不新增依赖

## Prompt 原文（用户）

> 读 @CLAUDE.md 和 @UI优化-新会话交接文档.md，按 §10 开工。先只改 app/globals.css，跑 npm test 把结果贴给我。

随后：

> 继续任务

（即按文档 §7 的顺序把余下文件全部做完，每个文件跑四闸门。）

## AI 输出摘要

按 §7 顺序改了 8 个样式文件，每个文件改完即跑 `npm test` / `npm run test:fixtures` / `npm run build` / `npm run probe:mobile`，全部通过后才进入下一个。

### 1. `app/globals.css`

- `--line` `#dcd3c1` → `#e3dccd`，`--line-2` `#c6bba4` → `#d1c8b6`：分隔线轻一档，纸色三档原值不动（第二轮再各放宽一档，见下）
- 新增 `--shadow-1`、`--shadow-2`
- 新增 `--container: 1080px`、`--container-narrow: 860px`
- 后续补 `--gap-row: 1px`、`--pad-card`（给上传页与材料页复用）

### 第二轮加强（用户反馈「没变化」之后）

第一轮交付后用户的判断是「怎么感觉 UI 没变化」。用 Edge 无头截图对照改前改后，确认判断成立：`--line` 只提亮约 3%（`#dcd3c1`→`#e3dccd`），而 `--shadow-1` 是 `0 1px 2px rgba(23,21,15,.04)`，在 `#efeade` 暖纸底上肉眼不可见。**边框变浅 + 阴影看不见 = 卡片层级反而比改前更平**，这是本轮最该记住的教训：只改 token 的「方向」而不改「幅度」，等于没改。

因此第二轮把幅度调到位（只动 token 与间距，不动任何结构）：

- `--line: #e7e0d2`、`--line-2: #d6cdbb`
- `--shadow-1: 0 1px 3px rgba(23,21,15,.07), 0 1px 1px rgba(23,21,15,.04)`
- `--shadow-2: 0 4px 12px rgba(23,21,15,.09), 0 1px 3px rgba(23,21,15,.05)`
- `--pad-card: 20px 22px`（卡片内呼吸再放宽 2px）
- `--container` 曾试 1040/820，最终按文档 §3 恢复 **1080/860**（规格不擅自改）
- 首页：`.flow .step` `padding: 22px 24px`、`.flow .ds` `margin-top: 10px` / `line-height: 1.8`、`.vs` 升用 `--shadow-2`、`.sect` 与 `.proof` 上间距 44→56px、`.proof` `padding: 26px 28px`

### 2. `app/home.css`

`.wrap` 收窄到 `--container-narrow`、`padding: 56px 24px 80px`；`.tagline` / `.flow` 间距提到 36px；`.flow` / `.vs` 用 `--line` + `--shadow-1`；`.vs` 子块 `padding: 22px 24px`。TSX 未动。

### 3. `app/upload/upload.css`

`.shell` 用 `--container-narrow`、`padding: 48px 24px 72px`；`.frame` 加 `--shadow-1`、`margin-top: 32px`；`.drop` 删掉原 `transition`（动效账不动），改用 `:hover` 换边框与纸背色，`.drop.disabled` 单独兜住禁用态；`.list` 改 `grid` + `gap: 1px` + 底色 `--line` 做发丝线，行内 `padding: 12px 14px`。

### 4. `app/doc/[id]/doc.css`

`.shell` 用 `--container`、`padding: 40px 24px 72px`；`.cols` 三栏 `gap: 0`，靠 `.col` 的左分隔线 + 24px 内边距分栏，首列无左线，`≤820px` 塌成单栏并清左线；`.colhd` 加 `border-top: 2px` 四维色；`.card` 加 `--shadow-1`、`padding: var(--pad-card)`、间距 16px；`.card .txt` 从 13.5px 提到 **17px**（正文可读性，对应试录报告里「1080p 正文仅 13.5px」的问题）；散落的 10/12/13px 全部归到 11 / 13.5px。

### 5. `app/session/[id]/session.css`

`.chat-shell` 用 `--container`；`.chat-body` `padding: 40px 24px 0`；`.turn` 加 `--shadow-1` + 左缘 3px 朱红线、纸背底；`.turn-error` / `.chat-placeholder` 同步。`cursor-blink` 唯一 keyframes 与 `2px / 1em / 1.05s steps(2,end)` 参数逐字未动。

### 6. `app/session/[id]/ask.css`

`.answer` 加 `--shadow-1`、`padding: 16px`；`:focus` 从朱红改 `--line-2` + `outline`（避免整块输入区被红框抢焦点）；`.answer-count` 加 `margin-right: auto`、同时删掉 `.answer-submit` 的 `margin-left: auto`，让字数与按钮真正两端对齐；`.ribbon-end` 用 `--red-deep` + `--line` 边框。`.answer-input` 的 6px 圆角是全站唯一圆角，未动。

### 7. `components/Bench.css`

`.bench` 底边从 `--line-2` 收到 `--line`；`.bench-seats` 用 `--container`；新增 `.seat.is-current { background: var(--paper); box-shadow: var(--shadow-1); }`，让「当前说话者」除朱红下划线与方点之外多一层纸面抬起。`transition: opacity 180ms`、`::after` 下划线、`.seat-pulse` 6×6 方点、`.is-past` 的 0.46 全部原样保留（`tests/bench.test.ts` 逐条卡着）。

### 8. `app/report/[id]/report.css`

- 容器：`.report-shell` / `.report-cover-inner` 改用 `--container`，内边距 24px
- 栏目：`.report-cols` gap 24px；`.report-col-title` 加 `border-top: 2px` 四维色 + 下边线，成为两栏的视觉锚点
- 卡片：`.risk-card` / `.perf-card` / `.high-item` / `.report-placeholder` / `.tr-item` / `.claim-diff` / `.delta-rows` / `.board-t` / `.trace-strip` 统一 `--shadow-1` + 16px 间距
- 数字：`.big-num` 42 → **62px**（进入五级字号），`.stamp-num` 42 → **62px** + 700；`.high-rank` 从衬线 600 改等宽 700，与序号语义一致
- 表头 `.board-t thead th` 颜色 `--ink-2` → `--muted`
- **未动**：`@media (max-width: 860px)` 单栏、`.quote-cite.is-hit` 的 `animation: quote-pulse 320ms ease-out 1 forwards`、`.spread-dot` 的 `border-radius: 50%`（既有散点，不属新增圆角）

### 9. `components/MockBadge.css`

`max-width: 1080px` → `var(--container)`、`padding: 6px 24px`（文档 §4.1 要求），与全站容器对齐。三句文案、零动效、窄屏 `flex-wrap` 全部保留。

### 逐节复核补漏（用户问「这里面的任务都做完了吗」）

把交接文档 402 行逐节读了一遍对照代码，补齐 4 处漏项：

1. **§4.1 MockBadge** 要求 `padding: 8px → 6px`，此前只对齐了容器宽度 → 补 `.mock-banner { padding: 6px 24px }`
2. **§4.6 风险条底** 要求 `--line-2`，此前写的 `--line` → 改 `.risk-bar` 与 `.perf-track` 的 `background` 为 `--line-2`（仍 3px 高、不圆角，填充 `--red` / `--green`）
3. **§4.6 最可能被追问的点** 要求三段之间有线分隔 → `.high-q` / `.high-why` / `.high-sug` 加 `padding-top: 8px` + `border-top: 1px solid var(--line)`，再用 `.high-q { border-top: 0; padding-top: 0 }` 去掉首段顶线，保持「一段一卡之外不再嵌卡片」
4. **§4.5 Bench current** 允许加大 `padding` → `.seat` `14px 18px 16px → 16px 20px 18px`

另修一处全局不一致：`home.css` / `upload.css` / `doc.css` 的 `.ribbon` 是 `10px 20px`，`session.css` 的 `.chat-ribbon` 是 `10px 18px` 且写死 `max-width: 1080px` —— 四者统一为 `10px 24px`，`.chat-ribbon` 改用 `var(--container)`。至此全站 CSS 里除 token 定义与 `@media (max-width: 860px)` 断点外，**不再有写死的像素容器宽度**。

## 我的修改

除上述 CSS 之外没有改任何 TSX / TS / fixture / prompt。逐文件 read 校验过写入结果；`globals.css` 的两处 token 补充（`--gap-row` / `--pad-card`）是在上传页与材料页改到一半时发现重复写死才回填的。

## Bug 与修复过程

1. **`npm test` 首跑 28 个文件未执行** —— 沙箱下 `spawn EPERM`（Next/Node 起子进程被拦）。用 `danger-full-access` 重跑即 416/416。与 `progress.md` 里 11-03 记的 `git push` 报 `couldn't create signal pipe` 同类，属环境权限而非代码问题。
2. **`build` 会杀死正在跑的 demo** —— 每次 `next build` 覆盖 `.next` 后，之前那个 dev 进程全 500，探针报「连不上 /api/health」。处置固定为：`job_kill` 旧 demo → `$env:MOCK_LLM='1'; node scripts/demo.mjs` 后台重启 → 等 `Ready` 再跑探针。第一次没等就探，拿到 `fetch failed`，重跑即 9/9。
3. **demo 起在 3000，探针默认 3111** —— 必须显式 `--base http://127.0.0.1:3000`，否则探针连到不存在的端口。这条 11-03 试录报告已记过，本次又验证一遍。
4. **编辑 `.board-t` 时撞上 auto-review 429** —— 一次 `edit` 因上游限流未落盘，读回文件确认 `.board-t` 仍缺 `box-shadow`、表头仍是 `--ink-2`，重试后补齐。教训：限流报错时不能假设「刚才那步成功了」，必须 read 回查。
5. **第一轮改完用户看不出变化** —— 见上面「第二轮加强」。根因不是改错了方向，而是幅度太小（3% 明度差 + 4% 透明度的阴影），而我又没有在交付前自己截图对比，只报了「四闸门全绿」。教训：视觉类改动必须自己先看渲染结果，测试全绿不等于改动能被看见。
6. **无头截图抓到骨架屏** —— 首次用 `msedge --headless=new --screenshot` 抓 `/doc/[id]`、`/report/[id]`，拿到的是空壳（Next 客户端渲染未完成）。必须加 `--virtual-time-budget=5000~8000` 才会等到真实内容。

## 四闸门结果

| 文件 | npm test | test:fixtures | build | probe:mobile 400px |
|---|---|---|---|---|
| globals.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| home.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| upload.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| doc.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| session.css + ask.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| Bench.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| report.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| MockBadge.css | 416/416 | 39/39 | 15 路由 | 9/9 |
| 第二轮加强 + 补漏（全站一次） | 416/416 | 39/39 | 15 路由 | 9/9 |

最终一次全站探针：9 / 9 页 `clientW = scrollW = 400`，无横向溢出。

## 视觉自检（无头截图，1440px 宽）

| 页面 | 结论 |
|---|---|
| `/` | 首屏标题与三问层级清楚；`.vs` 用 `--shadow-2` 后与上方流程卡的层级差看得出来 |
| `/upload` | MOCK 提示块（`--red-soft`）是页面上唯一的色块，角色明确；已接入材料表用 1px 发丝线分行，行高够 |
| `/doc/[id]` | 三栏 17px 正文读起来不挤；四维色顶线让「方法论 / 工程实现 / 价值与创新」一眼分区 |
| `/session/[id]` | 评审席三态可分：当前位纸面抬起 + 朱红下划线 + 方点，已问位 0.46 透明度；作答区字数与按钮两端对齐 |
| `/report/[id]` | 73 / 40 两个 62px 数字是首屏视觉锚；两栏分栏线（2px 四维色）把「材料风险 / 临场表现」分开；风险条与表现条同为 3px，底色 `--line-2` 后填充段更清楚 |

## 遗留问题

- **真机目视复核仍只做了一半**：已用 Edge 无头截图在 1440px 宽下逐页自检（见表），但**录屏口径是 1920×1080 + 浏览器 125%**，那个组合下的实际观感仍需你亲眼看一遍——尤其报告页首屏（73 / 40 两个 62px 数字占掉的高度）与材料页三栏 17px 正文。
- **报告页 `.big-num` / `.stamp-num` 从 42 提到 62** 属字号档位内调整，但两处同时放大后，报告页首屏信息密度会下降，录屏时可能需要重新确认取景。
- **`.drop` 删掉 transition 后**，拖拽悬停是瞬时变色，没有过渡；这是遵守「不新增动效」的有意取舍，不是遗漏。
- **第二轮（加强 + 补漏）改动尚未提交**：第一轮已随 `6f513a3` 推上 main；第二轮是对「看不出变化」的幅度修正与文档漏项补齐，在工作区等你确认后再一次性 commit。

## commit

- 第一轮：`6f513a3` `style(ui): 全站视觉精调 —— 分隔线轻一档、容器收窄、卡片统一阴影、正文提到 17px`（10 files，+263/−88），已 push 到 `main`
- 第二轮（加强 + 4 处补漏 + ribbon 统一）：待你确认视觉后提交
