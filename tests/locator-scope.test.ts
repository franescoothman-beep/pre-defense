import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAbsence, rateOf, attachLocator } from '../lib/locator.ts';
import type { Block } from '../lib/parse.ts';

/**
 * absence scope 校验的两个真实缺陷（阶段 4 判分时抓到）。
 *
 * 这两个都不是"跑不起来"，而是**指标被悄悄污染**：
 *   ① scope 匹配方向写反 → 合法的 absence 被判非法 → 覆盖率虚低
 *   ② 非法也算合法   → 覆盖率恒 100% → 变成一个永远好看的假指标
 * 两者叠加时，界面上看不出任何异常，只是数字不对。
 */

function blocks(): Block[] {
  return [
    { idx: 0, page: null, section: '1. 研究背景与意义', text: '本研究针对中小学校内课后服务的管理效率问题。' },
    { idx: 1, page: null, section: '1. 研究背景与意义', text: '现有研究多聚焦于政策文本分析。' },
    { idx: 2, page: null, section: '2. 数据与方法', text: '我们采集了某市三所小学一学期的课后服务记录，共计 1240 条。' },
    { idx: 3, page: null, section: '3. 实验结果', text: '模型的决定系数为 0.62。' },
  ];
}

test('verifyAbsence：scope 比章节名更长时也必须判合法（方向写反的真实回归）', () => {
  // 【真实踩过】模型给的 scope 通常是"章节名 + 补充说明"，比章节名长：
  //   scope = "2. 数据与方法：三所学校的办学性质、生源结构与年级分布"
  //   章节  = "2. 数据与方法"
  // 旧实现 `norm(b.section).includes(norm(scope))` 用短的包含长的，永远 false，
  // 结果模型明明指对了 §2，却被记成"scope 未落在已知章节"。
  const r = verifyAbsence(blocks(), '2. 数据与方法：三所学校的办学性质、生源结构与年级分布', 2);
  assert.equal(r.reason, 'scope 合法', '以已知章节名开头的 scope 必须合法');
});

test('verifyAbsence：scope 与章节名的**空格差异**不影响判定（第二次踩坑的回归）', () => {
  // 【真实踩过，且是改了方向之后才暴露的第二个坑】
  //   章节 = "2. 数据与方法"（norm 后仍带一个空格）
  //   scope = "考生回答及原文2.数据与方法中三校各年级条数分布"（无空格）
  // 改方向之前判不出，改方向之后"含空格"仍不包含"不含空格" → 还是误判。
  // 中文材料里这两者是同一种东西，空格只是排版差异。
  const r = verifyAbsence(blocks(), '考生回答及原文2.数据与方法中三校各年级条数分布', 2);
  assert.equal(r.reason, 'scope 合法', '空格差异不该影响"这一节存不存在"');
});

test('verifyAbsence：scope 少了章节名里的句点时判非法（如实反映，不硬凑）', () => {
  // 章节名 "2. 数据与方法"，scope 写成 "2数据与方法部分"（丢了那个点）。
  // 这不是空格差异，是**确实少了字符**。放松到"去掉标点再比"会让匹配烂掉
  // （"3 实验结果" 与 "3 实验结果分析" 这类也会混）。这里如实判非法。
  assert.equal(verifyAbsence(blocks(), '2数据与方法部分', 2).reason, 'scope 未落在已知章节');
});

test('verifyAbsence：空章节名不能让任何 scope 都合法', () => {
  // 若材料里存在 section 为空/极短的块，不得让任意 scope 通过。
  const b: Block[] = [
    { idx: 0, page: null, section: '', text: '无章节的块' },
    { idx: 1, page: null, section: ' ', text: '另一个无章节的块' },
  ];
  assert.equal(verifyAbsence(b, '这是一段毫不相干的检索范围', 0).reason, 'scope 未落在已知章节');
});

test('verifyAbsence：指向不存在的章节 → 如实记非法（不假装合法）', () => {
  assert.equal(verifyAbsence(blocks(), '5. 讨论与展望：这部分没有对照组', 3).reason, 'scope 未落在已知章节');
});

test('verifyAbsence：范围写法 / §写法仍然合法', () => {
  assert.equal(verifyAbsence(blocks(), '第 40–58 页', 1).reason, 'scope 合法');
  assert.equal(verifyAbsence(blocks(), '§3.2', 1).reason, 'scope 合法');
});

test('verifyAbsence：缺少 scope → 如实报缺（不能算合法）', () => {
  assert.equal(verifyAbsence(blocks(), undefined, 1).reason, 'absence 缺少 scope');
  assert.equal(verifyAbsence(blocks(), '   ', 1).reason, 'absence 缺少 scope');
});

test('verifyAbsence：absecne 的 verified 恒为 null（不进逐字命中率分母）', () => {
  assert.equal(verifyAbsence(blocks(), '2. 数据与方法', 2).verified, null);
});

test('rateOf：absence 覆盖率只数"合法"，非法必须留在分母外（不能当通过）', () => {
  // 【真实踩过】旧实现把 'scope 未落在已知章节' 也算进分子 → 覆盖率恒 100%，
  // 这个指标就失去了意义（评委看它是满分，其实模型一半的 scope 是编的）。
  const entries = [
    { kind: 'absence' as const, verified: null, reason: 'scope 合法' },
    { kind: 'absence' as const, verified: null, reason: 'scope 未落在已知章节' },
  ];
  const r = rateOf(entries);
  assert.equal(r.absence.total, 2, '两条都进分母');
  assert.equal(r.absence.ok, 1, '只有"合法"那条进分子');
  assert.equal(r.absence.rate, 0.5, '非法那条不该被算作通过');
});

test('rateOf：quote 分母含未命中（不剔除）', () => {
  const entries = [
    { kind: 'quote' as const, verified: 1 as const, reason: '命中' },
    { kind: 'quote' as const, verified: 0 as const, reason: '未命中' },
  ];
  const r = rateOf(entries);
  assert.equal(r.quote.total, 2, '未命中的也要留在分母里');
  assert.equal(r.quote.rate, 0.5);
});

test('verifyAbsence：2 字的真实章节名（摘要 / 引言）必须能匹配', () => {
  // 【为什么要有这条】上面为了防巧合给 scope 加了长度门槛，
  // 若把门槛也套到章节名一侧，"摘要"这种 2 字标题就会被判成"不存在"——
  // 等于宣称"你这篇论文没有摘要"，是明显的错。
  // 门槛只该管"scope 够不够长",不该管"章节名够不够长"。
  const b: Block[] = [
    { idx: 0, page: 1, section: '摘要', text: '本研究采集了三所小学的记录。' },
    { idx: 1, page: 1, section: '引言', text: '课后服务是近年政策重点。' },
  ];
  assert.equal(verifyAbsence(b, '摘要', 0).reason, 'scope 合法', '摘要是最常见的 2 字章节名');
  assert.equal(verifyAbsence(b, '引言', 1).reason, 'scope 合法');
  assert.equal(verifyAbsence(b, '摘要与关键词', 0).reason, 'scope 合法', '章节名+补充也认');
});

test('verifyAbsence：空 / 空白章节名不能让任何 scope 都合法', () => {
  const b: Block[] = [
    { idx: 0, page: null, section: '', text: '无章节的块' },
    { idx: 1, page: null, section: ' ', text: '另一个无章节的块' },
  ];
  assert.equal(verifyAbsence(b, '毫不相干的检索范围描述', 0).reason, 'scope 未落在已知章节');
});

test('rateOf：空数组不除零（返回 0 而不是 NaN）', () => {
  const r = rateOf([]);
  assert.equal(r.quote.rate, 0);
  assert.equal(r.absence.rate, 0);
  assert.ok(Number.isFinite(r.quote.rate));
});

test('attachLocator：absence 的 scope 合法时，locator 上也带原 scope、quote 为空串', () => {
  const { locator, result } = attachLocator(blocks(), {
    kind: 'absence',
    block_idx: 2,
    scope: '2. 数据与方法：年级分布',
  });
  assert.ok(locator);
  assert.equal(result.reason, 'scope 合法');
  assert.equal(locator!.scope, '2. 数据与方法：年级分布');
  assert.equal(locator!.quote, '', 'absence 的 quote 必须为空串，前端据此显灰不可点');
});
