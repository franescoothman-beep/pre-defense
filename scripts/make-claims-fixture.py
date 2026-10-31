"""生成 fixtures/llm/claims.json —— 质疑点抽取的 mock 回放数据。

两条硬约束（都是踩过的坑）：

1) **quote 必须逐字**：不手写，全部用脚本从 blocks 里按切片取。
   手写 quote 少一个字、改一个标点，机检就判 verified=0，命中率静默掉一截。

2) **claim 的 block_idx 必须落在"本批"里**：
   路由会执行 `if (!batch.includes(c.block_idx)) continue;`（防止模型编造块号）。
   所以 fixture 的批次划分必须和 `batchesOf()` 的真实输出一致——
   不能凭想象把 8 条 claim 平均分两批。
   实测该样例的批次为 [[1,3,4,6,7], [9]]（标题行 0/2/5/8 因过短被跳过）。

配套：scripts/test-fixtures.mjs 会复检这两条约束（阶段 6 要求提前落地）。
"""
import json

BLOCKS = json.load(open("fixtures/demo/sample-paper.blocks.json", encoding="utf-8"))["blocks"]
TEXT = {b["idx"]: b["text"] for b in BLOCKS}

# 与 lib/prompts/claims.v1.ts 的 batchesOf 保持一致：跳过 len<12 的块，每 5 块一批
usable = [b["idx"] for b in BLOCKS if len(b["text"].strip()) >= 12]
BATCHES = [usable[i:i + 5] for i in range(0, len(usable), 5)]


def q(idx: int, start: int, end: int) -> str:
    """从第 idx 块原文里取 [start, end) 切片，并断言它确实逐字存在。"""
    text = TEXT[idx]
    if end > len(text):
        raise AssertionError(
            f"切片越界 idx={idx} [{start}:{end}] 但该块只有 {len(text)} 字：{text}"
        )
    s = text[start:end]
    assert s in text, f"切片失败 idx={idx} [{start}:{end}]"
    assert 8 <= len(s) <= 60, f"quote 长度越界 {len(s)}: {s}"
    return s


def findq(idx: int, needle: str) -> str:
    """
    按「想引的整句」反查下标，再切片。

    比手算下标可靠得多：手算时一旦数错一个字，切片就从词中间开始，
    读起来是「哑变量处理。模型的决定系」这种残句——虽能过机检，
    但评审一眼就看出这不是人写出来的引用。
    """
    text = TEXT[idx]
    pos = text.find(needle)
    assert pos >= 0, f"idx={idx} 里找不到 {needle!r}"
    assert 8 <= len(needle) <= 60, f"quote 长度越界 {len(needle)}: {needle}"
    return text[pos:pos + len(needle)]


# ── 第一批 [1,3,4,6,7]：5 条 ────────────────────────────────────
batch0 = [
    {
        # 零样本 → absence（原文没有任何"样本代表性"的论证）
        "type": "method",
        "text": "只采了三所学校的数据，这个样本能代表全市的课后服务吗？",
        "block_idx": 3,
        "kind": "absence",
        "quote": "",
        "scope": "2. 数据与方法",
        "risk": 4,
        "dimension": "evidence",
    },
    {
        # 可引：样本来源那句（整句，语义完整）
        "type": "engineering",
        "text": "数据字段是学校自报的还是你采集的？家长评分有没有自评偏差？",
        "block_idx": 3,
        "kind": "quote",
        "quote": findq(3, "我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。"),
        "risk": 3,
        "dimension": "depth",
    },
    {
        # 可引：多元线性回归 + 哑变量（整句）
        "type": "method",
        "text": "用多元线性回归拟合满意度，变量的多重共线性做过检验吗？",
        "block_idx": 4,
        "kind": "quote",
        "quote": findq(4, "在建模上，我们采用多元线性回归拟合家长满意度，并将活动类型作为哑变量处理。"),
        "risk": 4,
        "dimension": "depth",
    },
    {
        # 可引：0.62 的决定系数（整句）
        "type": "engineering",
        "text": "决定系数 0.62 就被解读为「解释大部分差异」，这个判断有依据吗？",
        "block_idx": 4,
        "kind": "quote",
        "quote": findq(4, "模型的决定系数为 0.62，说明三类字段能解释大部分满意度差异。"),
        "risk": 3,
        "dimension": "evidence",
    },
    {
        # 可引：未划分训练/测试集（最硬的一条，整句）
        "type": "method",
        "text": "没有划分训练集与测试集，0.62 是不是过拟合的结果？",
        "block_idx": 6,
        "kind": "quote",
        "quote": findq(6, "实验在同一批数据上进行，未划分训练集与测试集。"),
        "risk": 5,
        "dimension": "evidence",
    },
]

# ── 第二批 [9]：只有 1 块，所以只放 1 条（不许硬凑）─────────────
batch1 = [
    {
        # 可引：结论段里的"进一步引入更多学校"（整句）
        "type": "value",
        "text": "既然要靠「引入更多学校」才敢验证稳健性，现在这个结论凭什么先下？",
        "block_idx": 9,
        "kind": "quote",
        "quote": findq(9, "后续将进一步引入更多学校的数据以验证模型的稳健性。"),
        "risk": 4,
        "dimension": "logic",
    },
]

# 断言每条 claim 的块号确实在本批（否则路由会静默丢弃）
assert len(BATCHES) == 2, f"批次数变了（{BATCHES}），fixture 需要同步重写"
for c in batch0:
    assert c["block_idx"] in BATCHES[0], f"batch0 含非法块号 {c['block_idx']}（本批 {BATCHES[0]}）"
for c in batch1:
    assert c["block_idx"] in BATCHES[1], f"batch1 含非法块号 {c['block_idx']}（本批 {BATCHES[1]}）"

seq = [
    {"inputHash": "batch0", "response": {"claims": batch0}},
    {"inputHash": "batch1", "response": {"claims": batch1}},
]

with open("fixtures/llm/claims.json", "w", encoding="utf-8") as f:
    json.dump(
        {
            "notes": (
                "MOCK 回放：质疑点抽取。quote 全部由脚本从 sample-paper.blocks.json 逐字切片生成；"
                f"批次与 batchesOf() 一致：{BATCHES}。"
            ),
            "seq": seq,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

print(f"批次: {BATCHES}")
print(f"claims 共 {len(batch0) + len(batch1)} 条；"
      f"quote 类 {sum(1 for c in batch0 + batch1 if c['kind']=='quote')}，"
      f"absence 类 {sum(1 for c in batch0 + batch1 if c['kind']=='absence')}")
for c in batch0 + batch1:
    if c["kind"] == "quote":
        print(f"  [{c['block_idx']}] {c['quote']}")
print("约束自检：块号全在本批 ✅，quote 逐字 ✅")
