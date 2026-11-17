# scripts/make-intro-docx.py —— 把 docs/作品介绍.docx 排成可提交的样子
#
# 为什么需要这一步（pandoc 直出的 docx 有四个问题）：
#   1) 中文字体是主题默认（Calibri + 宋体回退），技术评委看到的是「能开但不像文档」；
#   2) 图注前缀是英文 "Figure 1:" —— pandoc 把编号做成了 Image Caption 样式的
#      自动编号，而它的 zh-CN 术语表在 docx 写出器里缺 Figure/Table 条目；
#   3) 表格前后与标题的间距是默认值，8 页读起来挤成一团；
#   4) A4 与页边距跟着 reference.docx 走，不是 printable A4。
# 所以：pandoc 负责结构，这里负责排版。只改样式与图注编号，不改任何正文文字。

import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

DOCX = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/作品介绍.docx')
CJK = '微软雅黑'
LATIN = 'Microsoft YaHei'
MONO = 'NSimSun'
INK = RGBColor(0x1A, 0x1A, 0x1A)
GRAY = RGBColor(0x55, 0x55, 0x55)


def set_font(run_or_style, name_latin=LATIN, name_cjk=CJK, size=None, bold=None, color=None):
    font = run_or_style.font
    font.name = name_latin
    if size is not None:
        font.size = Pt(size)
    if bold is not None:
        font.bold = bold
    if color is not None:
        font.color.rgb = color
    # 中文必须单独写 w:eastAsia，否则 Word 仍按主题字体渲染汉字
    rpr = run_or_style.element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        rfonts = rpr.makeelement(qn('w:rFonts'), {})
        rpr.insert(0, rfonts)
    rfonts.set(qn('w:eastAsia'), name_cjk)
    rfonts.set(qn('w:ascii'), name_latin)
    rfonts.set(qn('w:hAnsi'), name_latin)


def main() -> int:
    if not DOCX.exists():
        print(f'[FAIL] 找不到 {DOCX}，先跑 pandoc 生成')
        return 1

    doc = Document(DOCX)

    # —— 页面：A4 + 2.2cm 边距，正文版心约 16.6cm ——
    for section in doc.sections:
        section.page_width, section.page_height = Cm(21.0), Cm(29.7)
        section.top_margin = section.bottom_margin = Cm(2.2)
        section.left_margin = section.right_margin = Cm(2.2)

    # —— 样式 ——
    styles = doc.styles
    normal = styles['Normal']
    set_font(normal, size=10.5, color=INK)
    normal.paragraph_format.line_spacing = 1.45
    normal.paragraph_format.space_after = Pt(4)

    for name, size, before, after in (
        ('Heading 1', 16, 18, 8),
        ('Heading 2', 12.5, 12, 4),
    ):
        st = styles[name]
        set_font(st, size=size, bold=True, color=INK)
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(after)
        st.paragraph_format.keep_with_next = True

    for name in ('Title', 'Subtitle', 'Date', 'Author'):
        if name in [s.name for s in styles]:
            set_font(styles[name], size=22 if name == 'Title' else 11, color=INK)

    if 'Image Caption' in [s.name for s in styles]:
        cap = styles['Image Caption']
        set_font(cap, size=9, color=GRAY)
        cap.paragraph_format.space_before = Pt(2)
        cap.paragraph_format.space_after = Pt(10)
        cap.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        # 拆掉样式上的自动编号（它渲染成英文 "Figure N:"），改成手写中文编号
        ppr = cap.element.pPr
        if ppr is not None:
            for numpr in ppr.findall(qn('w:numPr')):
                ppr.remove(numpr)

    fixed_captions = 0
    fig_no = 0
    first_h1 = True
    for para in doc.paragraphs:
        style = para.style.name

        if style == 'Image Caption' and para.text.strip() and not para.text.lstrip().startswith('图'):
            fig_no += 1
            if para.runs:
                para.runs[0].text = f'图 {fig_no}　{para.runs[0].text}'
            else:
                para.add_run(f'图 {fig_no}　')
            fixed_captions += 1

        # 一级标题另起一页（第一个除外）——8 个章节，按节翻比对折页好读
        if style == 'Heading 1':
            if first_h1:
                first_h1 = False
            else:
                para.paragraph_format.page_break_before = True

        # 行内 code（pandoc 给的是 Verbatim Char）：中文别掉字
        for run in para.runs:
            if run.style is not None and run.style.name == 'Verbatim Char':
                set_font(run, name_latin=MONO, name_cjk=MONO, size=9.5)

        # 图片段落居中
        if para._p.findall('.//' + qn('w:drawing')):
            para.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # 表格：表头加粗、单元格字号压到 9.5、整表居中
    for table in doc.tables:
        table.alignment = 1  # WD_TABLE_ALIGNMENT.CENTER
        for row_idx, row in enumerate(table.rows):
            for cell in row.cells:
                for para in cell.paragraphs:
                    para.paragraph_format.space_after = Pt(2)
                    para.paragraph_format.line_spacing = 1.2
                    for run in para.runs:
                        set_font(run, size=9.5, bold=True if row_idx == 0 else None, color=INK)

    doc.save(DOCX)
    print(f'[ok] {DOCX} 已排版：A4 / 微软雅黑 / 图注中文化 {fixed_captions} 处')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
