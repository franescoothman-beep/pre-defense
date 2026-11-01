import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scoreToPercent, SCORE_LABEL } from '../lib/prompts/evaluate.v1.ts';
import { DIMENSION_LABEL, DIMENSIONS } from '../lib/report.ts';

/**
 * 阶段 4 的 UI 契约测试（对着页面源码断言，不是对着截图）。
 *
 * 【为什么页面也要测】这一拍最容易悄悄回退的有四件事：
 *   ① 作答按钮又被禁用（"先别做判分"式回退）——那 quick 档闭环就没了
 *   ② 「结束并出报告」消失或加了前置条件 —— C11 就没了
 *   ③ 两栏合并成一栏 —— 材料问题与临场表现又混在一起（产品说不清）
 *   ④ risk / perf 共用一个颜色映射 —— C14 明令禁止
 * 这四件都不是"跑一次能发现"的问题：它们跑起来都正常，只是产品不完整了。
 */

const ROOT = process.cwd();
const sessionSrc = fs.readFileSync(path.join(ROOT, 'app', 'session', '[id]', 'page.tsx'), 'utf8');
const reportSrc = fs.readFileSync(path.join(ROOT, 'app', 'report', '[id]', 'page.tsx'), 'utf8');
const reportCss = fs.readFileSync(path.join(ROOT, 'app', 'report', '[id]', 'report.css'), 'utf8');

// ─────────────────────────── 聊天页：闭环 ───────────────────────────

test('聊天页：作答按钮真的接了 /answer（不是禁用占位）', () => {
  assert.match(sessionSrc, /\/answer`/, '必须调用 /api/sessions/:id/answer');
  // 旧的"阶段 4 才做"禁用写法不许回来
  assert.doesNotMatch(sessionSrc, /disabled[^>]*title="判分接口属阶段 4/);
  assert.match(sessionSrc, /onClick=\{submit\}/, '提交按钮必须接 submit');
});

test('聊天页：「结束并出报告」任何时刻可点（C11 的出口）', () => {
  assert.match(sessionSrc, /结束并出报告|生成答辩风险报告/);
  assert.match(sessionSrc, /\/end`/, '必须调用 /api/sessions/:id/end');
  // 它不能只在"主问问完"时出现——必须挂在缎带上（任何时候都渲染）
  assert.match(sessionSrc, /className="ribbon-end"/, '缎带上的出口必须常驻');
});

test('聊天页：三种 decision 都有分支（followup / ask / end）', () => {
  assert.match(sessionSrc, /'followup'/, '追问分支');
  assert.match(sessionSrc, /nextAction === 'report'|j\.decision === 'end'/, '结束分支');
  assert.match(sessionSrc, /setOpenSeq/, '下一问分支：重开 SSE');
});

test('聊天页：追问不走 SSE（避免多烧一次预算、多等一次延迟）', () => {
  // 追问文本在 /answer 响应里，直接展示
  assert.match(sessionSrc, /j\.followup\.question/, '追问文本来自 /answer 响应');
});

test('聊天页：追问有可见标记（否则用户以为评委问重了）', () => {
  assert.match(sessionSrc, /turn-followup/, '必须有「追问」标记');
});

test('聊天页：判分结果展示机检结论（verifiedOk），不只是分数', () => {
  assert.match(sessionSrc, /verifiedOk/);
  assert.match(sessionSrc, /出处已机检|出处未命中/);
});

test('聊天页：出处区分 quote 与 absence（absence 不可点开）', () => {
  assert.match(sessionSrc, /locator-absence|kind === 'absence'/);
});

test('聊天页：判分失败（degraded）不吞掉用户已经写下的答案', () => {
  assert.match(sessionSrc, /degraded/, '必须识别降级响应');
  assert.match(sessionSrc, /回答已保存|没能给出评价/, '要明确告诉用户答案没丢');
});

test('聊天页：防连点（提交中禁用），避免重复烧预算', () => {
  assert.match(sessionSrc, /submitting/);
  assert.match(sessionSrc, /disabled=\{submitting/, '提交中必须禁用');
});

// ─────────────────────────── 报告页：两栏与极性 ───────────────────────────

test('报告页：左栏「材料风险」与右栏「临场表现」是两栏（不许合并）', () => {
  assert.match(reportSrc, /aria-label="材料风险"/);
  assert.match(reportSrc, /aria-label="临场表现"/);
  assert.match(reportCss, /\.report-cols[\s\S]*grid-template-columns: 1fr 1fr/, '两栏用 grid 布局');
});

test('报告页：极性写死在 UI 上（材料风险越大越危险 / 临场表现越大越好）', () => {
  assert.match(reportSrc, /越大越危险/);
  assert.match(reportSrc, /越大越好/);
});

test('报告页：risk 与 perf 不共用颜色映射（C14）', () => {
  // risk 用朱红系（--red / --red-deep / --muted）
  const riskBlock = reportCss.slice(reportCss.indexOf('.risk-score'), reportCss.indexOf('.risk-uncovered'));
  assert.match(riskBlock, /var\(--red/, 'risk 必须用朱红系');
  assert.doesNotMatch(riskBlock, /var\(--green/, 'risk 不许用临场表现的竹青');

  // perf 用竹青
  const perfBlock = reportCss.slice(reportCss.indexOf('.perf-score'), reportCss.indexOf('.perf-track'));
  assert.match(perfBlock, /var\(--green/, 'perf 必须用竹青');
  assert.doesNotMatch(perfBlock, /var\(--red/, 'perf 不许用风险的朱红');
});

test('报告页：未覆盖的维度显式写「未覆盖」，不填 0', () => {
  // 【两个"未覆盖"必须分开标注，这是真实数据自相矛盾的修复】
  // 实测出现过：depth 维 risk_score=58（服务端聚合出的真实数字），
  // 旁边却写"本场未覆盖技术深度维度"，performance 里 depth 也是 null。
  // 根因是两栏共用了一个 askedDims 集合 —— 而"材料有没有这一维"与"本场问没问过"
  // 是两件完全不同的事。
  //   · risk_score === null  → 材料本身没有这一维的质疑点
  //   · askedInSession === false → 本场没轮到这一维（切 full 档能覆盖）
  assert.match(reportSrc, /材料无此维/, '材料没有这一维要说清是材料的问题');
  assert.match(reportSrc, /本场未问到这一维/, '有分但没问过要说清是本场轮次的问题');
  assert.match(reportSrc, /切 full 档可覆盖/, '要给出可执行出路');
  assert.match(reportSrc, /risk_score === null/);
  assert.match(reportSrc, /score === null/);
});

test('报告页：材料风险的 covered 与 askedInSession 是两个独立字段', () => {
  assert.match(reportSrc, /askedInSession\?: boolean/, '类型上就要能区分');
  assert.match(reportSrc, /r\.askedInSession === false/, '渲染时要真的用上这个区分');
});

test('报告接口：材料风险的 covered 取「材料有没有这一维」，不是「本场问没问过」', () => {
  // 对着服务端源码断言：防止有人"顺手"把它改回 askedDims
  const endSrc = fs.readFileSync(path.join(ROOT, 'app', 'api', 'sessions', '[id]', 'end', 'route.ts'), 'utf8');
  assert.match(endSrc, /hasMaterialForDim = cell\.risk_score !== null/, '材料风险的覆盖判据必须是聚合结果');
  assert.match(endSrc, /askedInSession: askedDims\.has\(dimension\)/, '本场是否问到要单独给一个字段');
});

test('报告页：absence 显灰且不可点开（disabled）', () => {
  assert.match(reportSrc, /l\.kind === 'absence'/, '必须按 kind 分支');
  assert.match(reportSrc, /disabled=\{l\.kind === 'absence'\}/, 'absence 必须不可点开');
});

test('报告页：覆盖缺口如实显示（quick 档覆盖不满 4 维）', () => {
  assert.match(reportSrc, /absentDimensions/, '必须显示本场未覆盖的维度');
  assert.match(reportSrc, /本场未覆盖/);
});

test('报告页：有审议轨迹（按顺序列出问与答）', () => {
  assert.match(reportSrc, /审议轨迹/);
  assert.match(reportSrc, /trajectory\.map/);
});

test('报告页：显式写出"本页尚未完成的部分"（不假装已完工）', () => {
  // 【为什么这条要测】阶段的诚实是这个作品拿分的部分。
  // 在阶段 4 就把报告页做成"看起来完整"、实际缺少看板与复练，是对用户说谎。
  assert.match(reportSrc, /本页尚未完成的部分/);
  assert.match(reportSrc, /质询风险看板/);
  assert.match(reportSrc, /复练|练回答|改材料/);
});

test('报告页：MOCK/降级模式可见（不标 = 用户以为这是真模型给的）', () => {
  assert.match(reportSrc, /degraded|服务端聚合与模板生成/);
});

test('报告页：不新增动效（#4 引用命中脉冲留给阶段 5）', () => {
  assert.doesNotMatch(reportCss, /@keyframes/, '这一拍不新增动效');
  assert.doesNotMatch(reportCss, /animation:\s/, '不许有动画声明');
});

test('报告页：窄屏塌成单栏（400px 可用）', () => {
  assert.match(reportCss, /@media \(max-width: 860px\)/);
  assert.match(reportCss, /grid-template-columns: 1fr;|grid-template-columns: 1fr;/);
});

test('报告页：颜色全走 token，无十六进制（CLAUDE.md 铁律 9）', () => {
  // 允许 background-image 之类的 rgba 通过 globals.css 定义；页面 CSS 不许自己写 #色值
  const hex = reportCss.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(hex, [], `报告 CSS 里出现了十六进制颜色：${hex.join(', ')}`);
});

// ─────────────────────────── 分数口径 ───────────────────────────

test('scoreToPercent：0–5 映射到 0–100，钳位不越界', () => {
  assert.equal(scoreToPercent(0), 0);
  assert.equal(scoreToPercent(3), 60);
  assert.equal(scoreToPercent(5), 100);
  // 越界输入必须被钳住，不许出现 -20 或 120
  assert.equal(scoreToPercent(-1), 0);
  assert.equal(scoreToPercent(6), 100);
});

test('SCORE_LABEL：五档都有中文解释（前端不让用户对着数字猜）', () => {
  for (const s of [0, 1, 2, 3, 4, 5]) {
    assert.ok(SCORE_LABEL[s], `第 ${s} 档必须有标签`);
  }
});

test('DIMENSION_LABEL：四维都有中文名（与报告页同源）', () => {
  for (const d of DIMENSIONS) {
    assert.ok(DIMENSION_LABEL[d], `${d} 必须有中文名`);
  }
});
