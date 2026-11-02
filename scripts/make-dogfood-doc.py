"""
把 README.md + 技术文档初稿拼成一份 DOCX，作为 4.3 节「狗粮自查」的第 3 份材料。

【为什么单独做这一步】
4.3 节要求"把 README.md + 技术文档初稿作为第 3 份材料上传，走完整场"。
上传接口只吃 docx/pdf，所以先转换。转换时保留标题层级——
docx 没有"页"，靠 §章节 定位，标题层级就是 section 的来源，
压平成一个段落会让锚点全部退化成"无章节"。
"""
import re
import sys
from pathlib import Path

from docx import Document

ROOT = Path(__file__).resolve().parent.parent
PARENT = ROOT.parent


def heading_level(line: str) -> int:
    m = re.match(r'^(#{1,6})\s+', line)
    return len(m.group(1)) if m else 0


def add_markdown(doc: Document, text: str) -> None:
    in_code = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            # 代码块压成一段等宽文本：提取正文用不着语法高亮
            if line.strip():
                doc.add_paragraph(line)
            continue
        if not line.strip():
            continue
        lvl = heading_level(line)
        if lvl:
            doc.add_heading(line[lvl:].strip(), level=min(lvl, 4))
            continue
        if line.startswith('|'):
            # 表格行原样保留（md 表格转 docx 表格代价大，正文提取不需要）
            doc.add_paragraph(line)
            continue
        if re.match(r'^[-*+]\s+', line):
            doc.add_paragraph(line[2:].strip(), style='List Bullet')
            continue
        if re.match(r'^\d+\.\s+', line):
            doc.add_paragraph(re.sub(r'^\d+\.\s+', '', line), style='List Number')
            continue
        doc.add_paragraph(line)


def main() -> None:
    out = ROOT / 'docs' / 'eval' / 'eval-03-self-dogfood.docx'
    doc = Document()
    doc.add_heading('预演 · 项目说明书与实现概要', level=0)

    readme = ROOT / 'README.md'
    if readme.exists():
        doc.add_heading('第一部分：README', level=1)
        add_markdown(doc, readme.read_text(encoding='utf-8'))

    tech = PARENT / '开发流程详细文档.md'
    if tech.exists():
        doc.add_heading('第二部分：开发流程详细文档（节选）', level=1)
        text = tech.read_text(encoding='utf-8')
        # 只取前 4 章：整份 62KB 会超出单次抽取的批次数，且第 5 章起是给 AI 的指令模板，
        # 不是"作品说明"，放进去会让评委抓着指令模板提问，偏题
        cut = text.find('\n## 5.')
        if cut > 0:
            text = text[:cut]
        add_markdown(doc, text)

    doc.save(out)
    print(f'[ok] {out.relative_to(ROOT)}  {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
