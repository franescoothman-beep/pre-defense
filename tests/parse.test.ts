import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsToParagraphs, cleanParagraphs, pagesToBlocks, paragraphsToBlocks, densityOf } from '../lib/parse.ts';

// 模拟中文 PDF：每个字一个 item，y 有抖动
function glyphItems(text: string, y = 100) {
  return [...text].map((ch, i) => ({ str: ch, transform: [40 + i * 12, 0, 0, 12, 0, y + (i % 2)] }));
}

test('itemsToParagraphs：还原被逐字空格化的中文', () => {
  const items = glyphItems('教育背景');
  const out = itemsToParagraphs(items);
  assert.equal(out[0], '教育背景', '汉字之间不应残留空格');
});

test('itemsToParagraphs：不同 y 的行分开（PDF 坐标 y 向下递减，y 大的在上）', () => {
  const items = [...glyphItems('第一行', 300), ...glyphItems('第二行', 200)];
  const out = itemsToParagraphs(items);
  assert.equal(out.length, 2);
  assert.equal(out[0], '第一行', 'y=300 在页面上方，应排在前');
  assert.equal(out[1], '第二行');
});

test('cleanParagraphs：去掉纯页码行、合并半句', () => {
  const raw = ['第 3 页', '这是一段被折断的半句话', '继续的下半句。', '', '  ', '另一段。'];
  const out = cleanParagraphs(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0], '这是一段被折断的半句话继续的下半句。');
  assert.equal(out[1], '另一段。');
});

test('pagesToBlocks / paragraphsToBlocks：page 与 section', () => {
  const paged = pagesToBlocks([{ page: 1, paragraphs: ['第1章 绪论', '正文一。'] }, { page: 2, paragraphs: ['正文二。'] }]);
  assert.equal(paged.length, 3);
  assert.equal(paged[0].page, 1);
  assert.equal(paged[0].section, '第1章 绪论');
  assert.equal(paged[2].page, 2);
  assert.equal(paged[2].section, '第1章 绪论', '章节应沿用到下一段');

  const flow = paragraphsToBlocks(['1.2 方法', '正文。']);
  assert.equal(flow.length, 2);
  assert.equal(flow[0].page, null, 'docx 走 flow，page 必须为 null');
  assert.equal(flow[1].section, '1.2 方法');
});

test('densityOf：薄材料判定（<10 块或 <1500 字 → thin）', () => {
  const thin = paragraphsToBlocks(['只有一句话。']);
  assert.equal(densityOf(thin), 'thin', '1 块 1 句必然 thin');

  // 12 块但总字数不足 1500 → 仍然是 thin（两个条件取"或"）
  const short = paragraphsToBlocks(Array.from({ length: 12 }, (_, i) => `第 ${i} 段正文，内容比较长一些以便通过体量阈值检查。`));
  assert.equal(densityOf(short), 'thin', '字数不足 1500 时即使块数够也是 thin');

  // 真正达到 normal：块数 ≥10 且字数 ≥1500
  const normal = paragraphsToBlocks(Array.from({ length: 12 }, (_, i) => `第 ${i} 段。` + '正文内容填充，'.repeat(20)));
  assert.equal(densityOf(normal), 'normal');
});
