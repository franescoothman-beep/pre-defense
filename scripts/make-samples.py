"""生成阶段 1 的 DoD 样本：中文 DOCX + 图片型 PDF（纯图无文本层）。
产物进 data/samples/（gitignore，不入库）。
"""
from docx import Document
from PIL import Image, ImageDraw, ImageFont

# 1) 中文 DOCX：多章节，用于验证 flow 模式 + section 回填
d = Document()
d.add_heading('第一章 绪论', level=1)
d.add_paragraph(
    '本文研究中药材热风干燥过程的多物理场耦合建模问题。现有文献多采用单场模型，'
    '忽略温度场与水分场的双向耦合，导致干燥终点预测偏差较大。'
)
d.add_heading('1.2 研究现状', level=2)
d.add_paragraph(
    '近年来，有限体积法与动边界收缩模型被逐步引入农产品干燥仿真，'
    '但多数工作缺乏对判停时刻数值稳定性的讨论。'
)
for i in range(3, 7):
    d.add_heading(f'第{i}章 实验与结果', level=1)
    d.add_paragraph(
        f'第{i}章正文内容：本节给出第{i}组实验的对照组设置、样本量与误差分析。'
        '实验采用同一批次药材，温度设定为 60 摄氏度，含水率采样间隔 5 分钟。'
    )
d.save('data/samples/test-cn.docx')

# 2) 图片型 PDF：整页只有一张位图，文字是画进像素里的，没有文本层
img = Image.new('RGB', (1240, 1754), 'white')
draw = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype('C:/Windows/Fonts/simsun.ttc', 40)
except Exception:
    font = ImageFont.load_default()
draw.text((80, 100), '这是一份扫描件形式的论文首页，整页都是图片，没有任何文本层。', fill='black', font=font)
draw.text((80, 180), '如果你能在字节里找到文字，说明系统做了 OCR。', fill='black', font=font)
img.save('data/samples/scanned.pdf')

print('samples ok')
