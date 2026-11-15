# 2026-11-15 · 原文侧栏可交互（点段定位 / 评委位置不被改 / 一键回到当前块）

## 目标

上一版（`f1811ac`）的右侧原文栏是**只读**的：点某一段没有任何反应，翻远了也没有回到当前块的入口。
录制现场评委大概率会问「这能点吗」——点了没反应，比明确不能点更糟。

这一轮把它补成可交互，同时守住三条底线：

1. **不许篡改现场事实**：用户翻页不能把「评委此刻在读 BLOCK 4」改成别的值。
2. **不许承诺不存在的动作**：`absence` 锚点证明的是「原文里没有这句」，没有可跳的目标，绝不做成按钮。
3. **不许新增动效**：动效账已封顶两处（`cursor-blink` / `scan-sweep`），侧栏只许 hover 换色。

## Prompt 原文

> 补一下

（上下文：我在上一条汇报里问了「侧栏现在是只读的，评委问『这能点吗』要不要补——点某段能定位，加一个『回到评委正在读的』入口」，用户答「补一下」。）

## AI 输出摘要

### 一、翻页与「评委在读」拆成两个状态

```tsx
const [peekIdx, setPeekIdx] = useState<number | null>(null); // null = 跟随评委
const currentBlockIdx = meta?.blockIdx ?? null;
const viewIdx = peekIdx ?? currentBlockIdx;
const isPeeking = peekIdx !== null && peekIdx !== currentBlockIdx;
```

`viewIdx` 是「用户翻的优先，否则跟随评委」；`isPeeking` 是「翻到了**别处**」，所以点当前块不算翻页（否则页头会写「查看 BLOCK 4」而下面高亮的也是 BLOCK 4，自相矛盾）。

### 二、评委换块 → 自动收回用户的翻页

```tsx
useEffect(() => {
  setPeekIdx(null);
}, [currentBlockIdx]);
```

不收回的话，下一问进来用户还停在上一问翻到的那段，看起来像「侧栏不跟了」。

### 三、点段定位走 `data-idx` 查，不依赖单个 ref

焦点既可能是评委的块、也可能是用户点的块，一个 `ref` 挂不了两个：

```tsx
const el = box.querySelector<HTMLElement>(`[data-idx="${viewIdx}"]`);
box.scrollTop +=
  elRect.top - boxRect.top - box.clientHeight / 2 + elRect.height / 2;
```

依赖从 `[meta?.blockIdx, blocks]` 改成 `[viewIdx, blocks]` —— 翻页也要滚。

### 四、每段改成 `<button>`，但 absence 仍是 `<span>`

```tsx
<button
  type="button"
  data-idx={b.idx}
  className={`orig-block${isNow ? ' is-now' : ''}${isView && !isNow ? ' is-peek' : ''}`}
  aria-current={isView ? 'true' : undefined}
  title={isNow ? '评委此刻在读这一段' : `跳到 BLOCK ${b.idx}`}
  onClick={() => gotoBlock(b.idx)}
>
```

两处出处条（历史条目 + 判分面板）按 `kind` 分流：

- `kind === 'quote'` → `<button className="locator locator-quote locator-jump">`，点一下把该块读到侧栏正中；
- `kind === 'absence'` → 仍是 `<span className="locator locator-absence">`，不挂 `locator-jump`。

`gotoBlock` 再点同一段 = 收回跟随：

```tsx
const gotoBlock = useCallback((idx: number) => {
  setPeekIdx((prev) => (prev === idx || idx === currentBlockIdx ? null : idx));
}, [currentBlockIdx]);
```

### 五、命中高亮仍只在「评委正在读的那一块」里标

```tsx
isNow && meta?.locatorKind === 'quote' && meta?.source
  ? splitByQuote(b.text, anchorQuote(meta, b.text))
  : [b.text, '', '']
```

翻页看上下文时整篇到处亮同一句话，会让人分不清哪一句是这一问的依据。

## Bug 与修复

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 截图里「原文」竖排成两行、回程按钮竖成一条 | `.orig-head` 是 `display:flex`，320px 栏里 5 个元素挤不下且默认 `flex-wrap: nowrap` | `flex-wrap: wrap` + `gap: 4px 8px` + `.orig-head > * { white-space: nowrap }` |
| 2 | 整屏截图里看不出命中高亮，怀疑 `.hi` 没生效 | 假警报：`.hi` 计算样式正常（`rgba(176,58,46,.09)` 底 + `rgba(176,58,46,.38)` 下划线），是 1440 宽整图缩略后看不清 | 用 `deviceScaleFactor: 2` + clip 截图复验，确认高亮本来就在；不动代码 |
| 3 | 先写的 10 条规格测试读的是 `<div className="orig-block">`，改 button 后一条会挂 | 测试与实现同步改的必然是同一个方向，容易漏 | 测试改成断言「往前找最近的 `<`，必须是 `<button`」+ 必须带 `type="button"`，从结构上钉死而不是钉字符串 |

## 门禁

| 项 | 结果 |
|---|---|
| `npm test` | **439 pass / 0 fail**（新增 `tests/orig-sidebar.test.ts` 9 条） |
| `npm run test:fixtures` | 检查项 51 · 失败 0 |
| `npm run build` | 成功 · 20 条路由 · `/session/[id]` 6.39 kB |
| `node scripts/verify-demo-loop.mjs` | `[OK]` 零 key 闭环走通，共 3 问，评委 3 位，报告生成成功；`[history]` 5 条，每条都留住了回答原文 + gaps + locators |
| `node scripts/probe-orig-sidebar.mjs` | `[OK]` 点段定位、评委位置不被改、可一键回到当前块 |
| `node scripts/probe-mobile.mjs --path /session/<id>` | 400px `clientW=400 scrollW=400`，无横向溢出 |
| 目视 | `.shots/orig-sidebar.png`（1440×1600）、`.shots/orig-hi-zoom.png`（2× 放大），高亮朱红底 + 朱红下划线清晰 |

## 环境坑（第二次踩到，记下来）

`npm run build` 会覆盖 `.next`，而仍在跑的 dev server 立刻报 `Cannot find module './887.js'`、`/api/demo` 500，`verify-demo-loop` 随即报
`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`（HTML 错误页被当成 JSON 解析）。

顺序必须是：**build → kill 旧 demo 作业 → 重起 demo → 再跑探针**。

## 遗留

- 侧栏目前只在 `> 900px` 时是常驻栏，窄屏（≤900px）折叠到正文下方；录制用 1440/1920，不受影响。
- 翻页状态不跨刷新保存（`peekIdx` 是纯前端 state）。录制是一次性连续操作，不需要。
- 评委位置（`is-now`）依赖 SSE `meta.blockIdx`，追问态由 answer 响应的 `followup.blockIdx` 提供，两处都已带 `quote`；若将来新增别的提问来源，要同步补 `quote`，否则该块只高亮整段、不标句。

## commit

`feat(session): 原文侧栏可交互——点段定位、回到评委正在读的`
