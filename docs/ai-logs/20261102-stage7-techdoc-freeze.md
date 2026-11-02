# 2026-11-02 技术文档 6 章 + 功能冻结 v1.0-freeze

## 目标

按 `指令包.md` §7 阶段 6 最后一项与 §8 阶段 7 第一项，做两件事：

1. **6 章技术文档**落成 PDF（提交清单 ⑥：PDF ≤30 页，三个重点章节标题对上官方措辞）
2. **功能冻结**：跑三项闸门 + 零 key 闭环复验 → 打 tag `v1.0-freeze`

意图：官方 15% 工程分里，"技术文档写的是方法还是功能清单"是明确的分档线。文档必须回答三个问题——
你怎么设计上下文和 Prompt、AI 生成的代码用什么架构且你怎么约束它、你怎么证明可复现。

## Prompt 原文

> 按阶段 7 执行交付物，不再改功能。
>
> 11-11 技术文档初稿，6 章按官方口径命名：
>      1 问题与用户 / 2 意图控制策略 / 3 架构设计 /
>      4 可复现性论证 / 5 评测与数据 / 6 局限与下一步

（`指令包.md:590-604`，以及 `提交清单.md:177-183` 的官方原文引用）

## AI 输出摘要

新增 `docs/technical-doc.md`（19728 字符 / 665 行）与 `docs/technical-doc.pdf`（15 页 / 618 KB），
新增 `scripts/make-tech-pdf.mjs`（pandoc + xelatex 生成，含缺字检测与页数校验）与
`scripts/pdf-pages.mjs`（PDF 指定页渲染成 PNG，供目视检查排版）。

文档六章内容取舍：

| 章 | 写的什么 | 为什么这么写 |
|---|---|---|
| 1 问题与用户 | 真实场景、目标用户与时机、产品形态、明确不做的事 | 先把"一次机会无法练习"这个洞写死，后面所有设计才有落点 |
| 2 意图控制策略与可证伪生成 | 五阶段 Prompt 链、上下文四条硬规则、强制打分被打歪的六档写死判据、材料风险为何不由模型给、v1 vs v2 三组对比、追问收敛纯函数化 | 官方原文点名"如何设计上下文和 Prompt"；本章占了全文最多篇幅，因为这是作品的方法论核心 |
| 3 架构设计 | 分层与依赖单向、**约束 AI 生成代码的六条机制**、锚点模型与四级机检回落、S1–S6、SSE、MOCK 回放 | 官方原文点名"AI 生成的代码采用什么架构，你如何约束它"——"六条机制"是直接冲着这半句写的 |
| 4 可复现性论证 | 三层可复现（L1 零 key 闭环最强 / L2 真实模型 / L3 结构）、fresh clone 曾走不通的真实故障、固定随机性手段表、锚点可复检、模型版本漂移 | 官方原文点名"可复现性论证"；把"哪一层最强、哪一层做不到"分清楚，比笼统说"可复现"可信 |
| 5 评测与数据 | 八项机检指标带样本量列、双采样恒定 vs 波动对照、三份使用记录、狗粮自查 8 条缺口、**§5.5 这些数字不能用来声称什么** | 数字必须带样本量，否则 100% 是骗人的；专门写一节"不能声称什么"是为了不被自己的数字带跑 |
| 6 局限与下一步 | 八条局限按严重度排序 | 评委最烦"没有局限"的文档；把最重的放第一条（评委质量无对照评估），比藏在第 8 条诚实 |

## 我的修改

1. **章名对齐官方措辞**：初稿第 2 章叫「意图控制与可证伪生成」，少了"策略"二字。官方原文是
   「意图控制策略（你是如何设计上下文和 Prompt 的）」，评委按关键词找章节时对不上会扣分。
   改成「意图控制策略与可证伪生成」（commit `7199565`），三章标题逐字可对。
2. **删掉重复的目录**：pandoc 用 `--toc` 自动生成目录，而我在 md 里手写了一份「## 目录」，
   PDF 里出现两套目录。删掉手写的（`--toc` 那份带页码，更有用）。
3. **删掉 md 里的 H1**：pandoc 用 `--metadata title=...` 生成封面标题，而 md 第一行也是
   `# 预演（Rehearsal）技术文档`，导致封面后正文开头又出现一次同名标题，且自动目录里多一项。
   把 md 的 H1 删了，标题只由 metadata 出。
4. **页面数字修正**：初稿写「`lib/` 16 个模块，2255 行业务逻辑」，实跑 `git ls-files lib | xargs wc -l`
   后是 3300 行左右。数字改准——文档里的数字评委可能随手抽验。

## Bug 与修复过程

### Bug 1：PDF 里中文代码块整段掉字

**现象**：第一版 PDF 生成成功（605 KB），但 pandoc stderr 刷出上百条：

```
[WARNING] Missing character: There is no 合 (U+5408) in font Consolas/OT:script=latn;language=dflt;
[WARNING] Missing character: There is no 法 (U+6CD5) in font Consolas/OT:script=latn;language=dflt;
[WARNING] Missing character: There is no 容 (U+5BB9) in font Consolas Bold/OT:script=latn;
```

**根因**：只设了 `mainfont=Microsoft YaHei`，但 pandoc 的代码块和**行内 code**都走 `monofont`，
我设的是 `monofont=Consolas`——Consolas 只有西文字形。而文档里行内 code 大量夹中文
（`` `scope 合法` ``、`` `本场 N 轮，覆盖 3/4 维` ``），于是这些中文在 PDF 里是**空白**。
最坑的是 pandoc 退出码仍然是 0，PDF 也正常生成——**这是一次静默的内容丢失**。

**修复**：同时设 `CJKmainfont` 与 `CJKmonofont`，monofont 换成同时含中英字形的字体：

```
-V mainfont=Microsoft YaHei  -V monofont=Sarasa Mono SC
-V CJKmainfont=Microsoft YaHei  -V CJKmonofont=Sarasa Mono SC
```

并在脚本里查 `fc-list` 挑一个真装了的等宽中文字体（`Sarasa Mono SC` / `NSimSun` / `SimSun` /
`Microsoft YaHei` 依次尝试），**把缺字警告当失败处理**：有 `Missing character` 就单独统计并打印，
不再让它悄悄过去。修完输出 `[ok] 无缺字警告`。

**教训**：`pandoc` 的退出码 0 不等于产物正确。字体缺字、emoji 无字形这类问题全都不影响退出码。
凡是"生成类"脚本，都要提取 stderr 里的警告并单独判定，否则验收时看起来是绿的、交上去是残的。

### Bug 2：✅ / ❌ 在中文字体里没有字形

**现象**：文档第 5 章用 `✅ 已做` / `❌ 未做` 做手段表，第 5.5 节用它们做"能说/不能说"清单。
字体换成雅黑后仍然报：

```
[WARNING] Missing character: There is no ✅ (U+2705) in font Microsoft YaHei/OT:script=latn;
[WARNING] Missing character: There is no ❌ (U+274C) in font Microsoft YaHei/OT:script=latn;
```

**根因**：微软雅黑不含 emoji 码位（emoji 要走 Segoe UI Emoji 之类的彩色字体，xelatex 处理不好）。

**修复**：全量替换成中文词——`✅` → 「已完成」、`❌` → 「未完成」（共 18 处）。
选中文词而不是 `[x]`/`[ ]`，是因为这份文档要给评委读，"已完成/未完成"零解释成本。

**教训**：交付产物（PDF/PPT/视频字幕）里不要依赖 emoji。它们在编辑器里好看，在生成管线里
是又一个静默丢字的坑。

### Bug 3：页数统计得 0，差点误判超限

**现象**：`docs/technical-doc.pdf` 明明 618 KB、15 页，但脚本输出：

```
[pages] 约 0 页（官方上限 30）
```

**根因**：我第一版用正则数 PDF 里的 `/Type /Page` 对象。xelatex 生成的 PDF 用了**对象流压缩**
（object streams），页面对象被打包进 `ObjStm` 里，明文里根本搜不到 `/Type /Page`。

**修复**：改用 `pdfinfo`（MiKTeX 自带，路径 `D:\Latex\texmfs\install\miktex\bin\x64\pdfinfo.exe`）
读 `^Pages:\s+(\d+)`；没有 pdfinfo 时才退回正则，并且**明确打印"页数由正则估算，可能偏低"的警告**。
另外把超限处理写死：`if (pages > 30) process.exitCode = 2`——超页不是警告，是失败。

**教训**：PDF 是压缩容器，不要假设内容明文可搜。数页数这种事有专门工具就用专门工具，
正则只配当兜底，而且兜底必须自己声明"我是估算"。

### Bug 4：封面与目录各重复一次

**现象**：第一版 PDF 打开后：pandoc 生成了封面标题 → 自动目录第一项又是「预演（Rehearsal）技术文档」→
然后是正文的 H1 又一次同名标题；且我手写的「## 目录」与 `--toc` 生成的两套目录并存。

**根因**：两处重复叠加——①md 里同时有 H1 和 metadata title；②md 里手写目录，同时又用了 `--toc`。

**修复**：删 md 的 H1（标题交给 metadata）、删手写目录（交给 `--toc`）。
重新生成后用 `pdftoppm -png -r 90 -f 1 -l 1` 渲染封面目视确认：标题一次、Contents 一次、无重复项。

**教训**：`--toc` 这类"自动生成"选项一旦开了，就要把文档里所有手写的同类内容清掉，
否则两者会一起出现——而且这类重复在纯文本 diff 里看不出来，只有渲染成图才看得见。
**生成类产物必须目视检查，不能只看脚本退出码。**

## 结果

### 技术文档

| 项 | 值 |
|---|---|
| 源码 | `docs/technical-doc.md` 19728 字符 / 665 行，U+FFFD = 0 |
| PDF | `docs/technical-doc.pdf` 618 KB / **15 页**（官方上限 30） |
| 缺字 | **0**（脚本检测，非人工目测） |
| 三章标题 | 意图控制策略与可证伪生成 / 架构设计 / 可复现性论证 —— 与官方措辞逐字可对 |
| 目视检查 | 封面、目录、正文第 5 页渲染成 PNG 逐页看过，排版正常 |

### 功能冻结（三项闸门 + 闭环 + tag）

| 闸门 | 命令 | 结果 |
|---|---|---|
| 单测 | `npm test` | **414/414** pass，0 fail |
| fixture | `npm run test:fixtures` | **39 项 · 0 失败** |
| 构建 | `npm run build` | **15 路由**无报错（`/report/[id]` 6.82 kB） |
| 零 key 闭环 | 重启 MOCK 服务 + `verify-demo-loop.mjs` | 会话 `9eb9c062`，三问 q1/q2/q3 正确、**3 评委**、报告 **4+4 维 / 7 高风险 / risk_score 81**，`[OK] 零 key 闭环走通` |
| tag | `git tag -a v1.0-freeze` | 打在 commit **`7199565`** |

### commit

- `2c57c42` `docs: six-chapter technical document + PDF build script`（4 文件 +763）
- `7199565` `docs: align chapter 2 title with the official wording`（2 文件）

## 遗留问题

1. **11-15 换机器复现未做**：需要在另一台电脑 + 新 Node 版本跑 `npm run demo`。
   本机 v24.18 全绿不代表别的 Node 版本也绿（尤其 `node:sqlite` 的 API 在 22.x/24.x 有差异）。
2. **技术文档还没给第二个人读过**：狗粮自查是我自己质询自己，缺少外部视角。
   11-16 提交演练时至少让一个人照着文档走一遍。
3. **PDF 页数只有 15 页**，离 30 页上限还有空间。如果需要补充内容（例如把 v1 vs v2 的完整
   原始 JSON 贴进附录），现在还有余量——但要在 11-16 之前定，别到 11-17 动。
4. **视频分镜尚未落到脚本文件**：`提交清单.md:169` 已定 6 段时间轴，但还没有逐镜台词与演示路径。
   11-12 第一件事就是把它写成 `docs/video-script.md`，录制时照念。
