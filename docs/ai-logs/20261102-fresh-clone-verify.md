# 2026-11-02 空目录 fresh clone 复现实测（发现安装命令的真问题）

## 目标

提交清单 ④ 与评分 25% 里最硬的一条：**"评委可一键复现"**。
README 写了四条命令，但我从来没有在**真正空目录 + 真正新 clone** 的环境里跑过——
一直在自己的开发目录里跑，那里有 `node_modules`、有 `data/app.db`、有 `.env.local`。
这种"在自己机器上能跑"的自信，正是这类项目最典型的假阳性。

目标：git clone 到临时目录 → 装依赖 → 起 demo → 走完闭环，全程录像前先跑通一遍。

## Prompt 原文

这不是一次 AI 会话的 prompt，而是一条自查纪律（来自 `指令包.md` §8）：

> 11-14 空目录 fresh clone + npm run demo（mock）复现验证并录屏，零 key 跑通

以及提交清单里反复出现的判据：

> **MOCK 回放 + README 一键复现** —— 官方 25% 原文点名"评委可一键复现"

## AI 输出摘要

做了三轮实测，结论与 README 原写法**不一致**，改掉了 README。

| 轮次 | 装法 | 结果 |
|---|---|---|
| 1 | `npm install --omit=optional`（README 原写法） | 闭环**能走通**，但日志出现 `Downloading swc package @next/swc-win32-x64-msvc... to C:\Users\...\local\next-swc` —— Next 在**运行期**发现缺 swc 就自己联网下载 |
| 2 | `npm i`（全量） | 一次装齐，`npm run demo` 直接起服务，**日志无任何 Downloading**，闭环走通 |
| 3 | 清理临时目录，`git status` 确认干净 | 无残留 |

两轮闭环的实测数字（同一台机器，两个独立 clone）：

| 轮次 | 会话 id | 三问 | 评委 | 报告 | 结果 |
|---|---|---|---|---|---|
| `--omit=optional` | `b3f91db0-ecc6-43b3-90d3-c1638256cfac` | q1 陈/q2 林/q3 赵 | 3 位 | 4+4 维 / 7 高风险 / risk_score 81 | `[OK] 零 key 闭环走通` |
| 全量 `npm i` | （同脚本第二轮） | 同上 | 3 位 | 4+4 维 / 7 高风险 / risk_score 81 | `[OK] 零 key 闭环走通` |

**结论：闭环本身是稳的（两种装法都能跑通），但"零网络"是假的。**

## 我的修改

### README 安装命令：`npm i --omit=optional` → `npm i`

理由链条：

1. `--omit=optional` 的本意是对的——省掉 `@napi-rs/canvas` 那个 28MB 原生包，本产品只做 PDF
   文本提取不渲染，用 `scripts/polyfill-canvas.mjs` 补替身就够。
2. **但 optional 里不只 canvas**。我数了 `package-lock.json`：**72 个 optional 包**，其中包含
   - `@next/swc-win32-x64-msvc` —— Next 的编译器二进制（本地开发必需）
   - `@tailwindcss/oxide-win32-x64-msvc` —— Tailwind v4 的编译器
   - `lightningcss-win32-x64-msvc`
   - `sharp` 全平台一堆
3. 于是 `--omit=optional` 把"安装期下载"变成了"**运行期下载**"。对评委来说这更糟：
   安装时断网他会看到明确报错，运行到一半才少见地卡住下载 swc，日志混在 dev server 输出里，
   很容易被误判成"这作品跑不起来"。

### 措辞收窄："零网络" → "不调用任何模型接口"

原 README 标题写「零 key、零网络」。这句话两个问题：

- **不准**：`git clone` 和 `npm i` 本身就要联网。说"零网络"是自相矛盾。
- **像承诺**：评委真按"零网络"准备（比如提前 clone 到离线机器再装），会被运行期下载 swc 打脸。

改成「零 key」，正文写清"**不需要 API key**"，并把安装阶段需要联网这件事在耗时表里体现
（`npm i` 1–2 分钟，约 400MB，含全平台预编译二进制）。

### 新增一节：为什么不省 optional（附实测对比表）

README 里直接放两张行对比表（`npm i` vs `npm i --omit=optional` 的结果差异），
并说明"用不到的原生包不会被执行，`polyfill-canvas.mjs` 仍然照常兜底"——
避免评委误以为装全量会有副作用。

## Bug 与修复过程

### Bug：`--omit=optional` 让 Next 在运行期联网下载 swc

**现象**：fresh clone 里按 README 原命令装完，起 `npm run demo`，日志在 `[demo] 已灌入内置样例`
之后出现：

```
Downloading swc package @next/swc-win32-x64-msvc... to C:\Users\Oct-2\AppData\Local\next-swc
```

然后才 `▲ Next.js 15.5.28 / ✓ Ready in 2s`。第一次跑的时候它其实**下载成功了**（我的机器有网），
所以闭环照样走通——**如果我只跑一遍就收工，这个问题永远不会被发现**。

**根因**：`@next/swc-win32-x64-msvc` 在 `package-lock.json` 里被标记为 `optional`
（Next 为了让不同平台共用一份 lockfile，把所有平台的 swc 都写成 optional）。
`--omit=optional` 一视同仁地跳过全部，于是本地缺编译器二进制，
Next 启动时发现缺失 → 回落到"自己下载"的路径。

**关键的认知修正**：我原来以为 `--omit=optional` 只影响 `@napi-rs/canvas`。
实际上它影响 **72 个包**，其中三个是本地编译必需的。这是一个"为了省 28MB 而牺牲 400MB 的必然性"的错误取舍。

**修复**：README 安装命令改回 `npm i`；在「为什么没有原生依赖」第 2 条补一句
「**注意：不要用 `--omit=optional` 省这个包**（见上文实测对比，那会让 Next 在运行期联网下 swc）」，
让未来想"优化"这一步的人先看到实测记录。

**验证**：全量安装后重新 clone 一次，`npm run demo` 日志干净（无 Downloading），
`verify-demo-loop.mjs` 走通。

### 教训（本次最重要的一条）

**"在我机器上能跑"和"从零能跑"是两个命题，而且第一个命题成立时第二个更容易被误判为成立。**

我此前所有验收（414 单测、39 项 fixture、build 15 路由、零 key 闭环）都是在开发目录里跑的，
那里有完整的 `node_modules`。开发目录里跑通只能证明"代码逻辑对"，
**不能证明"评委能复现"**——后者依赖安装路径、依赖平台二进制、依赖 lockfile 的 optional 标记。

对应到评分：可复现 25% 里，"我这儿能跑"一分不值，"空目录能跑"才是那一分。

### 副产物：一个"只跑一遍会漏"的检验方法

这个问题只跑 `--omit=optional` 一遍也会漏——因为它联网下载成功了。
发现它靠的是**两种装法对比着跑**：
一种有 Downloading、一种没有，差异本身才是证据。

以后凡是"安装脚本 / 启动脚本"类的改动，都要至少跑两种输入（正常 / 缺失）并对比日志，
而不是只跑正常路径看它绿了没有。

## 结果

| 项 | 值 |
|---|---|
| fresh clone 闭环 | ✅ 走通（三问、3 评委、4+4 维、7 高风险、risk_score 81） |
| 发现的问题 | 1 条真问题（运行期下 swc）+ 1 处措辞不准（"零网络"） |
| 修改文件 | `README.md`（安装命令 + 新增实测对比节 + 措辞收窄）、`.env.example`（注释措辞） |
| commit | `4b584de` `docs: fix the install command after real fresh-clone verification` |
| tag | `v1.0-freeze` 已移到 `4b584de`（纯文档改动，不触碰 `lib/`、`app/api/`、prompt、schema、fixture，仍在冻结边界内） |

## 遗留问题

1. **录屏还没拍**：这次跑的是验证，不是素材。11-14 要在**空目录**里重跑一遍并录屏，
   且录屏时要保留"打命令 → 等装 → 起服务 → 走闭环"的完整过程，不能剪成只剩成功那一下。
2. **换机器复现（11-15）仍未做**：本次是同一台机器、同一个 Node（v24.18）。
   换机器要验的是 `node:sqlite` 在别的 Node 版本（尤其 22.x）上的行为，
   以及没有 `docs/shots`、没有 `data/` 的全新环境。这台机器验不了。
3. **`npm i` 体积约 400MB**：如果评委网络慢，这会是最长的一段等待。已在 README 耗时表里写明。
   要不要提供离线包（`npm pack` 或提交 node_modules）—— 不提供，
   提交物里塞 400MB 依赖既不专业也违反仓库惯例。
4. **`sharp` 等用不到的原生包仍在安装**：理论上可以用 `overrides` 把它们排除，
   但那会让 lockfile 更难维护，且一旦将来真需要图片处理就踩坑。当前选择是不优化——
   400MB 换来"两种装法对比过、全量那条确定能跑"，比省 300MB 更值。
