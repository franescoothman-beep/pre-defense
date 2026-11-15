# 2026-11-15 · 同一个问题显示两遍（已答记录里混进了没答的轮次）

## 目标

用户录制前实测截图报：**追问在屏幕上出现两次**——上面「已答记录」里一条，下面问题卡里又一条。

## Prompt 原文

> 为什么显示两次问题？

（附截图：第 1 问「追问 陈评委」的历史条目 + 下面「追问」卡片 + 同一句追问文本 + BLOCK 3 扫读区 + 作答框）

## 根因

不是渲染重复，是**收录口径错了**。

服务端的 `turns` 是**全部轮次**，包含正在问、还没答的那一条（`answer` 为空串）。`GET /api/sessions/[id]` 原样把它们都放进 `history`：

```
server history: [
  { seq: 1, kind: 'question', ans: 111, ... },
  { seq: 2, kind: 'followup', ans: 0,   ... }   ← 还没答，但进了 history
]
```

前端 `page.tsx` 把 `data.history` 全量塞进 `aria-label="已答记录"` 的时间线，于是未答的追问既出现在时间线里，又出现在下面 `meta` 驱动的当前问题卡里。

`aria-label` 写的是「**已答**记录」，所以正确答案是：**没答完的不该进时间线**。

## 修法

```tsx
const serverHistory = (data?.history ?? []).filter((h) => (h.answer ?? '').trim() !== '');
const serverIds = new Set(serverHistory.map((h) => h.turnId));
const history: HistoryItem[] = [...serverHistory, ...pendingHistory.filter((h) => !serverIds.has(h.turnId))]
  .filter((h) => (h.answer ?? '').trim() !== '')
  .filter((h) => h.turnId !== verdictTurnId)
  .sort((a, b) => a.seq - b.seq);
```

合并后**再过滤一次**：本地乐观条目（`pendingHistory`）在降级提交等路径下也可能 `answer` 为空。

### 为什么不用 `slice(0, -1)`

「取最后一条以外」看着也能消掉重复，但它是**位置**口径，不是**语义**口径：
- 「插了追问但还没答」时最后一条是追问，切掉它没问题；
- 但「降级提交」（判分失败、`answer` 已存但 `score` 为空）时最后一条是**已答**的，切掉就丢了一条真记录；
- 将来若出现「预生成下一问」这类机制，位置口径直接错位。

语义口径只有一条：**时间线记录的是"我说过什么"，没说的话不占一行**。

## 验证

写了个 CDP 驱动脚本，按真实 UI 状态机连答五问，每问提交前比对「history 里的首行问题文本」与「当前问题卡文本」，检查是否重复：

```
#1 提交前: hist=0 turn="这 800 条评测集在调优时是全部参"              ✓ 不重复
#2 提交前: hist=0 turn="追问 / 这800条里有没有划出一部分"              ✓ 不重复
#3 提交前: hist=2 turn="当检索片段与问题不相关或为空时，你的"          ✓ 不重复
#4 提交前: hist=2 turn="追问 / 先回到兜底：检索片段为空或与"          ✓ 不重复
#5 提交前: hist=4 turn="从教务问答这一个评测集，到政务、医疗"          ✓ 不重复
最终: hist=4 ended=true
```

修前同一流程在第 2 问后 `histCount=2` 且追问重复；修后 `hist=0`。

（脚本自身踩了一个坑：第一版等待条件写成「状态文本匹配到『追问』就 break」，而追问态和提问态的状态文本都有这个词，导致第 2 次之后其实没真正提交。改成「问题卡文本发生变化」才可靠。教训同上次：驱动脚本必须镜像真实状态机，而不是匹配模糊文本。）

## 规格测试

新增 `tests/history-timeline.test.ts` 4 条：

1. `serverHistory` 必须按 `answer` 非空过滤（正则核对实际表达式）；
2. 合并后的 `history` 必须再过滤一次；
3. **不许用 `slice(0, -1)` 之类的位置口径**冒充「没答完」；
4. `verdictTurnId` 排他规则仍在（同一问答不许在判分面板与时间线各渲染一遍）。

## 门禁

| 项 | 结果 |
|---|---|
| `npm test` | **443 pass / 0 fail** |
| `npm run test:fixtures` | 检查项 51 · 失败 0 |
| `npm run build` | 成功 |
| `verify-demo-loop` | `[OK]` 3 问 / 评委 3 位 / `risk_score 75` / `[history] 5 条`每条都有回答原文 |
| `probe-orig-sidebar` | `[OK]` 侧栏交互不受影响 |
| `probe-answer-visible` | `[OK]` 答完仍能看见自己的回答 |
| `probe-mobile` | 400px `clientW=400 scrollW=400` 无溢出 |

## 遗留

- 「已答记录」标题下现在只显示答完的轮次；若一场会话中止在「尚未作答」状态，那一问不会出现在时间线里——这是符合语义的（它没被答过），但报告页的审议轨迹是另一套逻辑（用 `turns.filter(t => t.question !== '')`），两者口径不同且各自正确。
- `data/app.db` 里堆着历次探针造的会话，不影响新建会话。

## commit

`fix(session): 已答记录只收答完的轮次，同一个问题不再显示两遍`
