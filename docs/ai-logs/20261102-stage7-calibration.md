# 20261102-stage7-calibration · y 容差标定 + 5 分制锚点

## 目标

清掉狗粮自查（`docs/usage/usage-03-self-dogfood.md`）挂账的最后两条参数依据缺口：

1. `y 容差 2.5`（`lib/parse.ts:45 itemsToParagraphs`）没有标定过程；
2. 5 分制没有锚点写进给评委看的文档（`SCORE_LABEL` 只活在 prompt 源码里）。

对应技术文档 §6.1 第 5、8 两条「挂账」。

## Prompt 原文（会话开场）

> 读 `CLAUDE.md` 和 `progress.md`，从「下一步」继续。不要重新讨论选题。

随后按挂账清单定位两条缺口，先读 `lib/parse.ts` 与 `tests/parse.test.ts` 核实缺口属实（测试只测功能正确性，无容差扫描），再动手。

## AI 输出摘要

- 写出 `scripts/calibrate-y-tolerance.mjs`：对 `yTolerance` 取 1→5 做双向扫描——A 方向合成同行 glyph（jitter 0→4.0）找「仍保持一行」的最大抖动；B 方向合成相邻两行（spacing 16→4）找「仍保持两行」的最小行距。
- 扫描结果：容差 t 能吸收同行内 ≤t 的抖动；行距 ≥4 的相邻行在容差 ≤3.5 时都安全；容差 5 时抖动吸收封顶在 4、且 6pt 行距开始被并行。
- 结论：**2.5 = 吸收实测抖动（<2.4）与不并行 4pt 行距之间的安全中点**，不是拍脑袋。
- 把结论固化成 `tests/parse.test.ts` 2 条回归：抖动 2.4 必须仍一行 / 行距 4 必须仍两行（复用既有 `glyphItems` 辅助函数，默认容差即被测对象）。
- 技术文档 `docs/technical-doc.md`：新增 §5.3「两个曾被质疑"没有依据"的参数」——y 容差标定表 + `SCORE_LABEL` 六档判定条件与折算表（5→100 … 0→0）；§6.1 第 5、8 条改「已解决」；狗粮 8 条缺口「4 已改 4 挂账」改「6 已改 2 挂账」；原 §5.4/5.5 顺延为 §5.5/5.6，`§5.3` 交叉引用（第 46 行散点说明）同步改。

## 我的修改

- 初版脚本想复用 `scripts/hooks-for-scripts.mjs`——不存在。实际与 `scripts/test-fixtures.mjs` 一样内联 `registerHooks({resolve})`（无扩展名相对导入依次试 `.ts`/`.tsx`/`/index.ts`）。
- 交叉引用第一版写成「上面的标定表」，但表格在文字下方——改为「本节逐条补上」。
- `progress.md`（在仓库外，`git add ../progress.md` 报 fatal outside repository，属预期；progress.md 单独维护不进 rehearsal 仓库）新增 2026-11-03 会话小节 + 版本行 v2.1.11。

## Bug 与修复过程

无运行时 Bug。两条预防性修正：

1. **扫描脚本退出码**：安全区间断言失败时 `process.exitCode = 1`——标定脚本必须能挂进 CI 闸门，否则"标定过"只是口头。
2. **回归测试用默认参数**：两条新回归都不显式传 `yTolerance`，测的就是默认值 2.5 本身——显式传参会让测试在默认值被误改时依然全绿。

## 验证

- `node scripts/calibrate-y-tolerance.mjs` → `[OK] 2.5 处于安全区间`；
- `npm test` **416/416**（414 + 2 条标定回归）；
- `npm run test:fixtures` **39 项 0 失败**；
- `docs/technical-doc.md` 20682 字符、U+FFFD=0；
- commit `8700ed7 test: calibrate y-tolerance + anchor the 0-5 scoring rubric`（3 文件 +126/−10）；`v1.0-freeze` tag 移到该 commit（纯测试+文档，冻结边界内）。

## 遗留问题

- 狗粮挂账剩 2 条：评委质量无对照评估（需人工标注基线，超出预算）、自查重复执行记录（fixtures/eval/prompt-eval 三组数字已算部分回应）。
- 标定用的是合成 glyph 样本；真实双栏/表格 PDF 的抖动分布可能更宽，README「已知不支持」已写明边界。
