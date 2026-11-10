# 2026-11-10 · 功能冻结日三闸复验（为打 v1.0-provincial 前置）

## 目标

11-07 有一批 post-freeze commit（9 个，纯 CSS 精调 / 测试脚本 / 文案 / favicon），落在 `v1.0-freeze` 标签之后。
按 `CLAUDE.md` 冻结红线，这批改动属「录屏需要的界面文案、演示脚本」豁免范围（未触碰 `lib/`、`app/api/`、prompt、schema、fixture），
但从未补跑过三项闸门确认、也没打省赛标签。

今天是功能冻结日（2026-11-10），红线正式生效。用户要求确认这批 commit 在录制前仍是绿的，为 11-18 打 `v1.0-provincial` 提供回看证据。

## 动手前的边界勘察

- 先 `git status --short` 确认工作区干净 → 无输出，9 个 commit 已 push origin/main，本地领先 0。
- `git --no-pager tag -l` 确认 `v1.0-freeze` 指向 `1d383b6`；`git --no-pager log --oneline v1.0-freeze..HEAD` 列出 9 个 post-freeze commit：
  - `e47cd7d` docs: 补看板滚动与质询台微调的 AI 日志
  - `62a0d28` style(doc,session): 看板定高列内滚动、质询台去重标题并强化原文锚点，补站点图标
  - `c3dc515` refactor(doc): 质疑点页合并为控制台工具栏，三列看板加列槽与空状态，卡片重做层级
  - `5c34418` style(header): 按原意改成无衬线粗体标题、删句号、胶囊徽标、副标题收敛
  - `a7e83a3` style(header): 标题区收敛字距、句号降权、正文下划线改浅朱底高亮，三页补阶段徽标
  - `7dad061` style(ui): 第二轮把视觉层级真正拉开档
  - `6f513a3` style(ui): 全站视觉精调
  - `4d68741` test: add dry-run shoot walkthrough with real DOM clicking
  - `1bcc5b9` test: freeze mobile overflow regression probe into scripts
- 沙箱实测：`npm test` / `npm run build` 在本机需 `danger-full-access` 放宽权限一次（否则 spawn EPERM，progress.md 已记录）；`test:fixtures` 纯 Node 脚本同需放宽。

## 改动

本次**无代码改动**，只跑闸门 + 更新 `progress.md`（规划文档，不进仓库）。

`progress.md` 两处更新：
1. 顶部「当前状态」路由数 `15` → `18`（含后期新增的 `/icon.svg` 与 `/api/health`，均非回归；`/report/[id]` 6.82 kB）。
2. 「下一步」节新增「已完成（2026-11-06~11-07 · 全站 UI 精调 + 11-10 三闸复验）」5 条：把会话日志里没进表的 UI 工作（11-06 两轮精调、`a7e83a3`/`5c34418` 标题重构、`c3dc515` 质疑点页重构、`62a0d28` 看板滚动+favicon）与 11-10 三闸复验补成带 commit 与四闸结论的条目，并标注这批属冻结后豁免范围、未解冻。

## Bug 与修复过程

无新增 Bug。复核中发现两个**文档口径滞后**问题（已就地修，不涉及代码）：
1. progress.md 顶部「当前状态」与各阶段小结反复写「`npm run build` 15 路由」—— 实际 11-07 新增 `/icon.svg`、后期还有 `/api/health`，build 输出早已是 18 路由。数字差来自新增合法路由，不是回归。
2. 「下一步」表的「已完成」清单停在 11-02，11-06/07 那批 UI 精调只躺在会话日志里，没反映进表 → 补齐。

补充一个**测试运行的事实陷阱**（供后续回看）：`npm test` 在 416/416 全绿时，harness 末端仍报 `[exit code: 1]`。这是 Node test runner 把非零退出码透传，而 run summary 明确 `fail 0`；判断闸门是否通过必须看 `ℹ fail 0` 那行，不能看末尾 exit code。

## 验收（三闸 + 复用 11-07 的探针结论）

| 闸门 | 命令 | 结果 |
|---|---|---|
| 单测 | `node --import ./tests/hooks.mjs --test --test-isolation=none "tests/*.test.ts"` | **tests 416 / pass 416 / fail 0** |
| 回放剧本 | `node scripts/test-fixtures.mjs` | **检查项 39 / 失败 0** |
| 构建 | `node node_modules/next/dist/bin/next build` | **✓ Compiled successfully，18 路由，0 报错**（`/report/[id]` 6.82 kB；含 `/icon.svg` 与 `/api/health`）|
| 移动端 | 11-07 `npm run probe:mobile` 结论（本批未动布局，复用）| 9 / 9 无横向溢出（clientW=scrollW=400）|

结论：11-07 的 9 个 post-freeze commit **未破坏任何冻结契约**，三项闸门全部保持通过。

## 契约偏离记账

- 本次零偏离：纯文档更新 + 跑闸门，未触碰任何冻结红线文件。
- 11-07 那批 UI 改动本身的偏离已在各自 ai-log（`20261106-ui-refresh.md`、`20261107-header-refresh.md`、`20261107-doc-board-refactor.md`、`20261107-board-scroll-session-tweak.md`）逐条记账，本轮未新增。

## 遗留

- **`v1.0-provincial` 按排期 11-18 提交当天打，本次未提前打**（距提交还有 8 天，冻结期内仍可能为录制微调文案）。
- **录制前必跑运行期验证**：`verify-demo-loop.mjs`。11-03 试录暴露本机 `data/app.db` 会因「重新抽取」漂移导致 `E_NO_ANCHOR` 让零 key 闭环直接挂；修法靠 `_repair-demo.mjs` 按 seed 原 id 重插（只动 gitignore 的库、不动代码）。此步须起 MOCK 服务 + 种子库，属「开录当天」步骤，本次未跑。
- 换机器复现（11-15）、提交演练（11-16）、正式录制与剪辑配音（11-12~11-13）均待做。

## commit

本次未产生 commit（`progress.md` 为规划文档、不进 `rehearsal` 仓库；本 ai-log 随后续某次提交入库）。
