"""生成 MOCK 演示模式的内置样例材料。

为什么必须内置而不是"用评委自己上传的文件"：
    MOCK 回放是**序号驱动**的（见 lib/mock.ts），回答顺序固定。
    如果允许任意材料，模型输出与材料必然错位——评委会看到"引用一句不存在的原文"，
    这比没有演示模式更糟。所以演示模式只认这份预置材料。

产物 fixtures/demo/ 入库（这正是"评委可一键复现"的载体）。
"""
import json
import os
from docx import Document

OUT = "fixtures/demo"
os.makedirs(OUT, exist_ok=True)

# ── 1) 一份"有真问题"的论文式材料（用于演示质疑点抽取）──────────────
# 刻意埋了 4 类可被追问的硬伤：无对照组、样本量偏小、只有单次实验、结论外推。
doc = Document()
doc.add_heading("1. 研究背景与意义", level=1)
doc.add_paragraph(
    "本研究针对中小学校内课后服务的管理效率问题，提出一套基于行为记录的评估模型。"
    "现有研究多聚焦于政策文本分析，较少涉及日常管理数据的量化建模。"
)
doc.add_heading("2. 数据与方法", level=1)
doc.add_paragraph(
    "我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。"
    "数据包含学生参与时长、活动类型与家长反馈评分三类字段。"
)
doc.add_paragraph(
    "在建模上，我们采用多元线性回归拟合家长满意度，并将活动类型作为哑变量处理。"
    "模型的决定系数为 0.62，说明三类字段能解释大部分满意度差异。"
)
doc.add_heading("3. 实验结果", level=1)
doc.add_paragraph(
    "实验在同一批数据上进行，未划分训练集与测试集。"
    "结果显示，参与时长与满意度呈显著正相关，回归系数为 0.34，p 值小于 0.05。"
)
doc.add_paragraph(
    "我们认为该结论可以推广到全市乃至全省的课后服务管理场景。"
)
doc.add_heading("4. 结论", level=1)
doc.add_paragraph(
    "本模型能够有效预测家长满意度，为学校管理者提供决策参考。"
    "后续将进一步引入更多学校的数据以验证模型的稳健性。"
)
doc.save(os.path.join(OUT, "sample-paper.docx"))

# ── 2) 预解析的 blocks（避免演示时还要真跑一次解析）──────────────
blocks = [
    {"idx": 0, "page": None, "section": "1. 研究背景与意义", "text": "1. 研究背景与意义"},
    {
        "idx": 1, "page": None, "section": "1. 研究背景与意义",
        "text": "本研究针对中小学校内课后服务的管理效率问题，提出一套基于行为记录的评估模型。现有研究多聚焦于政策文本分析，较少涉及日常管理数据的量化建模。",
    },
    {"idx": 2, "page": None, "section": "2. 数据与方法", "text": "2. 数据与方法"},
    {
        "idx": 3, "page": None, "section": "2. 数据与方法",
        "text": "我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。数据包含学生参与时长、活动类型与家长反馈评分三类字段。",
    },
    {
        "idx": 4, "page": None, "section": "2. 数据与方法",
        "text": "在建模上，我们采用多元线性回归拟合家长满意度，并将活动类型作为哑变量处理。模型的决定系数为 0.62，说明三类字段能解释大部分满意度差异。",
    },
    {"idx": 5, "page": None, "section": "3. 实验结果", "text": "3. 实验结果"},
    {
        "idx": 6, "page": None, "section": "3. 实验结果",
        "text": "实验在同一批数据上进行，未划分训练集与测试集。结果显示，参与时长与满意度呈显著正相关，回归系数为 0.34，p 值小于 0.05。",
    },
    {
        "idx": 7, "page": None, "section": "3. 实验结果",
        "text": "我们认为该结论可以推广到全市乃至全省的课后服务管理场景。",
    },
    {"idx": 8, "page": None, "section": "4. 结论", "text": "4. 结论"},
    {
        "idx": 9, "page": None, "section": "4. 结论",
        "text": "本模型能够有效预测家长满意度，为学校管理者提供决策参考。后续将进一步引入更多学校的数据以验证模型的稳健性。",
    },
]

with open(os.path.join(OUT, "sample-paper.blocks.json"), "w", encoding="utf-8") as f:
    json.dump({"blocks": blocks}, f, ensure_ascii=False, indent=2)

print("demo fixtures ok:", sorted(os.listdir(OUT)))
