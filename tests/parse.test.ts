import test from 'node:test';
import assert from 'node:assert/strict';
import {
  itemsToParagraphs,
  cleanParagraphs,
  pagesToBlocks,
  paragraphsToBlocks,
  densityOf,
  isSection,
  dropRunningHeads,
} from '../lib/parse.ts';

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

// ── y 容差 2.5 的标定（scripts/calibrate-y-tolerance.mjs 的结论固化成回归）──
// 扫描结论：容差 t 能吸收同行内 ≤t 的基线抖动；行距 ≥4 的相邻行在容差 ≤3.5 时都不会被并行。
// 2.5 = 吸收实测 PDF 抖动（<2.4）与不并行 4pt 行距之间的安全中点。
test('y 容差标定：同行抖动 2.4 仍是一行（默认容差 2.5）', () => {
  const items = glyphItems('基线抖动不超过二点四', 100, 2.4);
  const out = itemsToParagraphs(items);
  assert.equal(out.length, 1, '抖动 2.4 < 2.5，必须仍聚成一行');
});

test('y 容差标定：行距 4 的相邻行在默认容差下不并行', () => {
  const out = itemsToParagraphs(
    [...glyphItems('上行文字内容', 200), ...glyphItems('下行文字内容', 196)],
  );
  assert.equal(out.length, 2, '行距 4 ≥ 安全下界，不得并成一行');
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

// ── isSection：真实文档的标题形态（这里的每一条都是踩过的坑）────────

test('isSection：「数字 + 点 + 空格 + 汉字」必须识别为标题', () => {
  // 早期正则只允许"数字后直接跟汉字"，导致「1. 研究背景与意义」漏判，
  // cleanParagraphs 会把标题与下一段正文合并成一块 → section 全错位
  assert.equal(isSection('1. 研究背景与意义'), true);
  assert.equal(isSection('3. 实验结果'), true);
});

test('isSection：「数字 + 顿号」与「中文数字 + 顿号」', () => {
  assert.equal(isSection('1、绪论'), true);
  assert.equal(isSection('一、绪论'), true);
});

test('isSection：多级编号与「第X章」', () => {
  assert.equal(isSection('1.2 研究现状'), true);
  assert.equal(isSection('2.1.3 实验结果'), true);
  assert.equal(isSection('第3章 实验与结果'), true);
  assert.equal(isSection('第三节 方法论'), true);
});

test('isSection：正文段落与超长行不算标题', () => {
  assert.equal(isSection('本研究针对中小学校内课后服务的管理效率问题，提出一套基于行为记录的评估模型。'), false);
  // 行首虽是数字编号，但整行太长 → 仍是正文
  assert.equal(
    isSection('1. ' + '这是一段很长的正文内容，'.repeat(5)),
    false,
    '超过 48 字必须判为正文',
  );
});

test('isSection：标题行不被 cleanParagraphs 与下一段合并', () => {
  const raw = ['1. 研究背景与意义', '本研究针对中小学校内课后服务的管理效率问题，提出一套评估模型。'];
  const out = cleanParagraphs(raw);
  assert.equal(out.length, 2, '标题必须独立成段');
  assert.equal(out[0], '1. 研究背景与意义');
});

// ── dropRunningHeads：去页眉页脚 ─────────────────────────────

test('dropRunningHeads：跨页重复的短行被删，正文不被删', () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({
    page: i + 1,
    paragraphs: ['某某大学硕士学位论文标题', '第' + (i + 1) + '章 正文内容各不相同，用于验证不重复的行会被保留。'],
  }));
  const out = dropRunningHeads(pages);
  assert.equal(out[0].paragraphs.length, 1, '重复页眉应被删掉');
  assert.match(out[0].paragraphs[0], /正文内容各不相同/);
});

test('dropRunningHeads：页数太少（<3）时不动手', () => {
  const pages = [
    { page: 1, paragraphs: ['重复行', '正文一。'] },
    { page: 2, paragraphs: ['重复行', '正文二。'] },
  ];
  const out = dropRunningHeads(pages);
  assert.equal(out[0].paragraphs.length, 2, '2 页的重复不具统计意义，宁可不动');
});
