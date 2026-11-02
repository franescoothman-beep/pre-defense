# 2026-11-02 · 阶段 6 第 5 项补全：首页 / 移动端 400px / 截图工具

## 目标

指令包 §7 第 5 项「UI 打磨」原文要求的是五件事：**首页、加载态、评委切换、报告排版、移动端 400px**。
此前（commit `98d2778`）只做了报告排版那一块（每维评委打分散点 + 覆盖度文案），
首页还是阶段 0 的占位页（`app/page.tsx` 只显示「预演。STAGE 0 · SCAFFOLD READY」）。

本次补齐：**首页重写** + **移动端 400px 横向溢出修复**，并给加载态/评委切换做一次现状核查。

## Prompt 原文

> 继续任务，按照 @指令包.md

（对应 指令包 §7 阶段 6 第 5 项：
「UI 打磨：首页、加载态、评委切换、报告排版、移动端 400px」）

## AI 输出摘要

### 1. 首页整页重写（`app/page.tsx` 113 行 + 新建 `app/home.css` 362 行）

原来是阶段 0 占位。重写为**服务端组件**（无客户端状态、无 LLM 调用、直接输出 HTML，评委首屏更快）。
结构按「首页必须回答的三个问题」排：

| 区块 | 回答的问题 | 内容 |
|---|---|---|
| `.ribbon` | 一句话定位 | 上传材料 → 三位 AI 评委质询 → 风险报告 |
| `.hero` + `.flow` | 这是什么 | 「预演。」wordmark 62px + tagline + 三步卡片（STEP 01 上传 / 02 被质询 / 03 看风险）+ 主按钮 |
| `.vs` 两栏 | 和「找个 AI 问几个问题」有何不同 | 左栏"普通做法" 4 条 vs 右栏"这里" 4 条 |
| `.proof` 朱批块 | 凭什么信你 | 锚点 + 逐字机检 + QUOTE/ABSENCE 两类视觉区分 |
| `.foot` | 怎么试 | 开始一场 / `/api/health` |

**设计取舍（已写进 `app/page.tsx` 头注释）**：首页不堆功能列表，而是把「证据链」单独做成一个朱批区块。
理由是官方 25% 实用 + 20% 创新里，这件作品唯一别人做不出来的硬差异就是
「每条结论都能一键追回原文那一句」；功能列表谁都会写。

### 2. 移动端 400px 横向溢出（真 bug，两个根因）

指令包要求页面在 400px 下可用。截图目测发现右边缘文字被切，怀疑是横向溢出。

**第一次判断错了**：以为是 `.tagline { max-width: 56ch }` 这类 `ch` 单位在中文下算太宽
（`ch` 按"0"字宽 ≈0.5em，56ch≈378px，加 padding 就超 400px）。
按这个判断加 `.tagline, .sect .lede, .proof .tx { max-width: none }` 后重截，**仍然溢出**。

**改用探针实测**才定位到真正的两个撑宽元素：

1. `app/home.css` 的 `.ribbon` —— `display:flex` 单行、无 `flex-wrap`，
   「上传论文 / 项目文档 / 简历 → 三位 AI 评委轮番质询 → 答辩风险报告」这句中文不换行就把 body 撑宽。
2. `components/MockBadge.css` 的 `.mock-banner` —— 同样是单行 flex，
   「MOCK 演示模式 · 零 key 可复现 · 评委发言为录制回放，非实时模型输出」撑宽。

修法：两处在 `@media (max-width: 720px/640px)` 里加 `flex-wrap: wrap`，
并让文字块 `flex: 1 1 100%` + `min-width: 0` 独占一行。`max-width: none` 保留但降级为"顺带清理"，
注释也按实测改写（原本注释把 `ch` 说成根因，与事实不符）。

## 我的修改

- 改写 `app/home.css` 窄屏注释：从「`ch` 单位超宽」改为「实测定位到 `.ribbon` 与 `.mock-banner` 两个单行 flex」，
  并把 `max-width: none` 的理由降级为"窄屏本来排不下 N 字约束"。
- 删掉探针临时文件（`public/probe*.html`、`scripts/tmp-*.mjs`），只保留 `scripts/shot.mjs`。
- 截图产物留在 `docs/shots/`（未入 git，见"遗留问题"）。

## Bug 与修复过程

### Bug 1：`ch` 单位误判为 400px 溢出根因（诊断错误，不是代码错误）

- **现象**：400px 截图右边缘文字被切。
- **错误判断**：`.tagline { max-width: 56ch }` 在中文下超过容器宽度。
- **为什么错**：`max-width` 只会让元素**更窄**，永远不会撑宽父容器——它根本不可能造成横向溢出。
  这是一条基础 CSS 事实，第一版分析违背了它。
- **怎么定位到的**：写了个探针页 `public/probe.html`，用 iframe 以 `width:400px` 载入目标页，
  在 `load` + 2.5s 后遍历 `contentDocument.querySelectorAll('body *')`，
  把 `getBoundingClientRect().right > clientWidth` 的元素按 right 降序写进 `document.title`，
  再用 Edge `--headless=new --dump-dom` 读回 title。
  第一次跑返回 `{"vw":400,"scrollW":400,"worst":[]}` —— 修完 flex-wrap 之后已经不溢出了。
- **修复**：`.ribbon` + `.mock-banner` 加 `flex-wrap: wrap`。
- **教训**：**`max-width` 不可能造成横向溢出**。看到溢出先找 `display:flex` 单行不换行、
  `white-space:nowrap`、定宽 `width`/`min-width`、以及 `100vw` 这几类，别从 `max-width` 开始猜。

### Bug 2：无头 Edge 的 `--window-size=400` 截图看不出真实 400px 布局

- **现象**：修完 flex-wrap 后重截 400px，图里仍像被切。
- **原因**：`--screenshot` 模式下 `--window-size` 有最小宽度限制，实际视口不是 400px，
  截图是被裁出来的假象。
- **怎么绕过**：改用 iframe 探针把视口精确设成 400px（iframe 的 `width:400px` 就是真实布局宽度），
  再量 `scrollWidth`。这样拿到的才是真布局。
- **教训**：**`--window-size` 截图 ≠ 真实视口宽度**。量移动端布局要用 iframe 或 CDP
  `Emulation.setDeviceMetricsOverride`，不能只看截图。

### Bug 3：CDP 直连方案在本机跑不通（两次）

- 先试 `/json/new?url`（需要 PUT）→ `CDP 未就绪`。
- 再试 browser 级 `/json/version` + `Target.createTarget` → 同样 `CDP 未就绪`（`--remote-debugging-port` 没能绑定）。
- **放弃 CDP，改用 iframe + `--dump-dom`**，一次就跑通了。
- **教训**：定位 CSS 布局问题不需要 CDP，iframe 探针更轻、更稳；CDP 留给需要真实设备像素比/触屏事件的场景。

## 现状核查：加载态 / 评委切换（未改动，本就齐备）

| §7 要求 | 现状 | 位置 |
|---|---|---|
| 加载态 | 齐备 | `upload/page.tsx:310` 解析进度 `正在解析… N%`；`doc/[id]/page.tsx:264,289` `正在抽取…` / `正在排席位…`；`session/[id]/page.tsx:476,613` `正在生成报告…` / `正在发言… 已收到 N 字`；`report/[id]/page.tsx:282` `正在读取报告…` |
| 评委切换 | 齐备 | `components/Bench.css:33` 动效 #3「评委切换 180ms」（只动 opacity，不做位移/缩放/发光） |
| 报告排版 | 齐备 | commit `98d2778`（每维评委打分散点 + 覆盖度带轮数文案） |
| 移动端 400px | 本次修复 | 首页 + MockBadge 两处 `flex-wrap` |

四个页面探针实测（iframe `width:400px`）：

```
[ok]   /                                                    vw=400 scrollW=400
[ok]   /upload                                              vw=400 scrollW=400
[ok]   /report/1ff8f81d-56a4-405c-bc3d-18771abe21a5         vw=400 scrollW=400
[ok]   /session/a83a3bad-...                                vw=400 scrollW=400
[ok]   /doc/86322517-36ae-46cc-8dfa-300150d283dd            vw=400 scrollW=400
```

## 结果

- `npm test` → **414 / 414 全绿**
- `npm run test:fixtures` → **39 项检查 · 0 失败**
- `npm run build` → **通过，15 路由**（`/report/[id]` 6.82 kB）
- build 后重启 MOCK 服务 → `node scripts/verify-demo-loop.mjs` → **`[OK] 零 key 闭环走通，共 3 问，评委 3 位，报告生成成功`**
  （material_risk 4 维 / performance 4 维 / 高风险 7 条 / 风险分 81）
- 十六进制颜色：`app/*.css` 里只有 `globals.css` 的 token 定义有（`#efeade` 等 17 处），
  `home.css` 与 `MockBadge.css` **零个**（铁律 9）。
- `npx tsc --noEmit`：`app/` 与 `lib/` 零错误（`tests/*` 的 TS5097 是既有告警，测试走 hooks 跑、build 不编译 tests）。

## 遗留问题

1. `docs/shots/*.png` 是临期截图产物，已确认被 `.gitignore:34` 的 `docs/shots/` 忽略，不会误入提交；
   README 目前也没有引用它们，需要时再挑一两张入 `docs/`。
2. 首页文案「PDF / DOCX」是准确的（PPTX 已锁死不支持），但 `.flow` 第一卡没提"切块后保留页码与章节"对 PDF 的依赖
   —— 页面 `.ds` 里已写，不再展开。
3. 400px 探针是一次性脚本，已删；如果之后还要回归移动端，建议把 iframe 探针固化进 `scripts/`（现在没有自动化守卫）。
