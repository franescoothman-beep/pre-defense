# 2026-11-15 会话页右侧原文栏（P2）：把「这句话在哪一段」放回整篇

## 目标

用户第三次录制前实测报了三条，前两条（一问就结束、答完看不见自己的回答）在上一轮已修，
这一轮做第三条：

> 「回到原文这个功能，我只能看到一个片段，单独给一个窗口在旁边跳转是不是更好。」

翻成可验收的话：**问题卡旁边常驻一栏原文，当前 block 居中并高亮，能上下滚看前后文。**

## Prompt 原文（摘要）

- 「回到原文这个功能，我只能看到一个片段，单独给一个窗口在旁边跳转是不是更好」
- 「一一做」（批准 P2，按我提的方案：右侧固定一栏 + 当前 block 居中高亮 + 可上下滚动）

## AI 输出摘要

### 1. 先证明缺口在哪，而不是凭观感改

扫读区 `app/session/[id]/page.tsx:716-742` 只渲染 `meta.source` 一个字符串，
而 `meta` 里只有 `blockIdx / blockTotal / candidateTotal / source / page / section / locatorKind / verified` ——
**没有前一块、没有后一块、没有全篇**。所以「开个窗口看上下文」不是排版问题，
是**数据根本没有到前端**：得新增一条取全篇的路径。

三条候选路径比较后选了第三条：

| 做法 | 否决理由 |
|---|---|
| 塞进 SSE meta | meta 是每问一条的轻量事件，几百 KB 原文会把「思考态」的即时性拖垮 |
| 塞进 `GET /api/sessions/[id]` | 这是轮询接口（`reloadSession` 每问都调），每问重传全篇 |
| **新增 `GET /api/docs/[id]/blocks`** | 原文是**材料级**、不随会话推进变化，取一次即可 |

`lib/session.ts:387` 的 `loadBlocksOfDoc(docId)` 已经是现成实现（`select idx, page, section, text from blocks where doc_id = ? order by idx`），
新路由只是把它挂出去，**没有新增任何查询逻辑**。

### 2. 为什么是「常驻栏」而不是「弹窗 / 抽屉」

用户说的是「单独给一个窗口在旁边」——重点不是"窗口"，是**在旁边**。
这一栏要回答的问题永远是：「评委拿这句话质问我，它在原文哪一段、前后写了什么」。
弹窗会把**问题本身**盖住，读者得来回关开才能对照；常驻栏让「问题」与「它的原文位置」同屏。
所以最终是 `grid-template-columns: minmax(0, 1fr) 320px`，右侧 `position: sticky; top: 12px`。

- `minmax(0, 1fr)` 而不是 `1fr`：grid 的经典坑——长串英文/URL 会把左栏撑出网格宽度，`minmax(0, …)` 才允许收缩。
- 320px 定宽：13.5px 字号下一行约 19 个汉字，读着不挤；左栏仍有 ~700px，问答流不会被压碎。
- `max-height: 62vh`：比一屏短一截，保证问题卡与作答框仍在视野里——否则「对照原文」要滚整页，等于又把问题挪出屏幕。
- `@media (max-width: 900px)` 落成一栏，并且把 `max-height: none` + `position: static`：小屏不该再套一个内层滚动条（双重滚动的典型坏体验）。

### 3. 高亮：又是那条「不许塞 HTML」

`meta` 原本**没有 quote 字段**，只有整块 `source`。要让侧栏标出"被引用的那一句"，
得把 quote 也带下来。三处同时改，口径一致：

- `app/api/sessions/[id]/stream/route.ts` 重播分支与新问分支的 meta 各加 `quote: anchor.quote`；
- `app/api/sessions/[id]/answer/route.ts` 的 followup 返回值加 `quote: fAnchor?.quote ?? ''`；
- `app/session/[id]/page.tsx` 的 `SseMeta`、`AnswerResp.followup`、以及 `setPendingHistory` 里的锚点快照都补 `quote`。

渲染照抄 `app/doc/[id]/page.tsx:62-82` 的口径：

```ts
function splitByQuote(source: string, quote: string): [string, string, string] {
  if (!quote) return [source, '', ''];
  const i = source.indexOf(quote);
  if (i < 0) return [source, '', ''];
  return [source.slice(0, i), quote, source.slice(i + quote.length)];
}
```

外加一个 `anchorQuote(meta, blockText)`：**只在本块里标**（`blockText.includes(q) ? q : ''`），
同一句话若在别处也出现，不该跟着一起亮。

`.orig-text .hi` 与 doc 页 `.src .hi` 同一口径（`background: var(--red-soft); border-bottom: 1px solid var(--red-line)`），
让"文档页看到的命中"和"录制现场看到的命中"是同一个视觉约定。

### 4. 扫读区不删

一开始想过「侧栏替代扫读区」，读 `tests/scan.test.ts` 第 ⑥ 条（`aria-label="评委正在读的原文"` 到下一个 `</section>` 的切片里必须同时有 `scan-text` 与 `meta.source`）时想清楚了：

- 扫读区回答「评委**现在正在读**哪几行」——是一次**动作**，配 2.6s 光带，随这一问结束就停；
- 侧栏回答「这句话在整篇的**第几段**」——是一个**坐标**，要能一直滚。

过程要短，坐标要全。两块都在，各说一件事。

### 5. 滚动居中，而不是滚动到顶

```ts
const box = origRef.current;
const el = origCurRef.current;
if (!box || !el) return;
const boxRect = box.getBoundingClientRect();
const elRect = el.getBoundingClientRect();
box.scrollTop += elRect.top - boxRect.top - box.clientHeight / 2 + elRect.height / 2;
```

顶层对齐会让上下文只剩"下面一半"；居中才让读者看到这句话**前后都有字**——这才是"回到原文"的证据形态。
依赖 `[meta?.blockIdx, blocks]`：块变了或全篇刚取回来都重新居中。

## Bug 与修复过程

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `npm test` 430 → 1 fail：`S3：模型输出一律纯文本渲染` | 我在 `splitByQuote` 的注释里写了 `dangerouslySetInnerHTML` 这个词，`tests/cursor.test.ts:120-123` 是**正则扫源码、不剥注释** | 注释改写为「S3 基线不允许把原文/引文塞进 HTML」，不留那个词 |
| 2 | `npm run build` 后 `verify-demo-loop` 报 `Unexpected token '<'` | build 覆盖 `.next`，还在跑的 dev server 模块丢失 | kill 旧 job 重启 demo（与本轮改动无关的老坑，记在这里免得再踩） |
| 3 | 侧栏截图里 BLOCK 3 上有两段相邻文本 | 不是 bug：block 3 的 `text` 自带小标题（"2. 系统设计与实现" 在后面一块的开头），`section` 字段重复了一次 | 保留原样——原文是原文，不该为了好看去重排 |

## 门禁

- `npm test` **430 / 430**，fail 0
- `npm run test:fixtures` **51 项 / 0 失败**
- `npm run build` 成功，**20 条路由**（新增 `/api/docs/[id]/blocks`），`/session/[id]` 6.12 kB
- `verify-demo-loop`（`$env:BASE=http://127.0.0.1:3111`）`[OK]`：3 问 / 评委 3 位 / 高风险 8 / `risk_score 75` / `[history] 5 条` 每条都有回答原文 + gaps + locators
- `probe-answer-visible` `[OK]`
- `probe-mobile` 400px：`/session/{id}` `clientW=400 scrollW=400` 无横向溢出
- 截图目视两张：
  - `.shots/p2-orig.png`（主问 block 4 → 追问 block 3 之后）：侧栏「原文 · 当前 BLOCK 3 · 全篇 11 段」，BLOCK 3 有朱红左边线 + 提亮底色，并已滚到居中偏上；
  - `.shots/p2-q3.png`（停在第 3 问，许教授主问，`locatorKind=quote`，quote = "系统整体采用 BERT 句向量召回与 GPT 类生成模型级联的架构"）：该句在侧栏里**带朱红底 + 朱红下线**，一眼可辨。

## 遗留

- 侧栏目前**只读**：点某一段不会跳回/定位到别处，也没有"从某一处回到当前块"的按钮。够录制用（镜头要的是"看见上下文"），但评委会问"能点吗"——要不要做，等下一轮确认。
- `absent` 类型（`locatorKind === 'absence'`）的 claim 没有 quote 可高亮，侧栏只标当前块不标句子。这是对的：absence 的语义就是"这段里没有"，硬标一句反而在撒谎。
- `data/app.db` 里堆着历次探针造的会话（本轮的 `64708a23` / `882935e2` / `0e1237eb` 等），不影响新建会话，录制前不必清库。
- 本轮临时脚本 `tmp-make-session.mjs` / `tmp-q.mjs` / `tmp-to-q3.mjs` / `tmp-stop-q3.mjs` 已全部删除；`.shots/` 已加进 `.gitignore`。

## commit

见下一次 `git log -1`（本轮一个 commit，按铁律 1）。
