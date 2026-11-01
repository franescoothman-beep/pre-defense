import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeLocators, verifiedOkOf, validateFollowup, roundOfSeq, roundOfLegacy } from '../lib/grade.ts';
import type { Block } from '../lib/parse.ts';

/**
 * lib/grade.ts 是判分链路的"洗数据"层：机检 + 归属校验。
 *
 * 【为什么这一层必须单测】它做的是"把模型的话变成敢入库的事实"，
 * 而这正是本作品创新主张的落点。模型不会主动告诉我们它编了引用——
 * 只有这里的机检能把"编"和"真"分开。若不测，判分一直"看起来成功"。
 */

function blocks(): Block[] {
  return [
    { idx: 0, page: 1, section: '摘要', text: '本研究采集了某市三所小学一学期的课后服务记录，共 1240 条。' },
    { idx: 1, page: 1, section: '摘要', text: '我们发现参与课后服务的学生学业成绩平均提升 12%。' },
    { idx: 2, page: 2, section: '第三章 数据', text: '抽样采用分层随机抽样，按学校规模分三层，每层按比例抽取。' },
    { idx: 3, page: 3, section: '第三章 数据', text: '由于三所学校均为城镇学校，本研究的结论不适用于农村地区。' },
  ];
}

// ─────────────────────────── 机检：quote 类 ───────────────────────────

test('gradeLocators：原地命中 → verified=1', () => {
  const g = gradeLocators(blocks(), [{ block_idx: 0, quote: '某市三所小学一学期的课后服务记录' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].verified, 1);
  assert.equal(g[0].reason, '原地命中');
  assert.equal(g[0].page, 1);
  assert.equal(g[0].section, '摘要');
});

test('gradeLocators：块号漂了但在 ±2 邻域 → 命中并记录 movedBy', () => {
  // quote 在第 2 块，模型说第 1 块
  const g = gradeLocators(blocks(), [{ block_idx: 1, quote: '抽样采用分层随机抽样' }]);
  assert.equal(g[0].verified, 1);
  assert.equal(g[0].blockIdx, 2, '应解析到真正的块');
  assert.equal(g[0].movedBy, 1, 'movedBy>0 说明模型块号漂了（prompt 质量信号）');
});

test('gradeLocators：命中不了 → verified=0，但**条目必须保留**（进分母）', () => {
  const g = gradeLocators(blocks(), [{ block_idx: 0, quote: '这句话原文里根本没有出现过' }]);
  assert.equal(g.length, 1, '未命中要保留，否则命中率分母被剔除=自欺');
  assert.equal(g[0].verified, 0);
  assert.match(g[0].reason, /未命中/);
});

test('gradeLocators：block_idx 越界 → 整条丢弃（前端拿它取原文只能拿到空）', () => {
  const g = gradeLocators(blocks(), [{ block_idx: 99, quote: '某市三所小学' }]);
  assert.equal(g.length, 0);
});

test('gradeLocators：quote 过短(<8) → verified=0 且保留', () => {
  const g = gradeLocators(blocks(), [{ block_idx: 0, quote: '小学' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].verified, 0);
  assert.match(g[0].reason, /过短/);
});

// ─────────────────────────── 机检：absence 类 ───────────────────────────

test('gradeLocators：absence 类 verified=null（不参与逐字命中率）', () => {
  const g = gradeLocators(blocks(), [{ kind: 'absence', block_idx: 2, scope: '第三章 数据' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'absence');
  assert.equal(g[0].verified, null, 'absence 不进 quote 分母，这是 §3.10 写死的口径');
  assert.equal(g[0].quote, '', 'absence 不该塞 quote');
  assert.match(g[0].reason, /scope 合法/);
});

test('gradeLocators：absence 的 scope 落在已知章节 → 合法', () => {
  const g = gradeLocators(blocks(), [{ kind: 'absence', block_idx: 0, scope: '摘要' }]);
  assert.equal(g[0].reason, 'scope 合法');
});

test('gradeLocators：absence 的 scope 是范围写法(§3.2) → 合法', () => {
  const g = gradeLocators(blocks(), [{ kind: 'absence', block_idx: 0, scope: '§3.2' }]);
  assert.equal(g[0].reason, 'scope 合法');
});

test('gradeLocators：absence 的 scope 落在未知章节 → 如实记录（不假装合法）', () => {
  const g = gradeLocators(blocks(), [{ kind: 'absence', block_idx: 0, scope: '第七章' }]);
  assert.equal(g[0].reason, 'scope 未落在已知章节');
});

// ─────────────────────────── verified_ok 聚合 ───────────────────────────

test('verifiedOkOf：有一条 quote 命中 → 1（不要求全中）', () => {
  const g = gradeLocators(blocks(), [
    { block_idx: 0, quote: '某市三所小学一学期的课后服务记录' }, // 中
    { block_idx: 1, quote: '这句编的' }, // 没中
  ]);
  assert.equal(verifiedOkOf(g), 1, '一条站得住的锚点就够用户点回原文判断');
});

test('verifiedOkOf：全部 quote 未命中 → 0', () => {
  const g = gradeLocators(blocks(), [
    { block_idx: 0, quote: '编的引用一' },
    { block_idx: 1, quote: '编的引用二' },
  ]);
  assert.equal(verifiedOkOf(g), 0);
});

test('verifiedOkOf：absence 有 scope → 算通过（即便一条 quote 都没中）', () => {
  const g = gradeLocators(blocks(), [
    { block_idx: 0, quote: '编的引用一' },
    { kind: 'absence', block_idx: 2, scope: '第三章 数据' },
  ]);
  assert.equal(verifiedOkOf(g), 1);
});

test('verifiedOkOf：空数组 → 0（没有出处就不算可溯源）', () => {
  assert.equal(verifiedOkOf([]), 0);
});

// ─────────────────────────── 追问归属校验 ───────────────────────────

const ALLOWED = new Set(['c1', 'c2', 'c3']);

test('validateFollowup：正常追问 → 通过', () => {
  const r = validateFollowup(
    { question: '这 1240 条里各校各年级分别占多少', target_claim_id: 'c2', resolved: false },
    { allowedIds: ALLOWED, currentClaimId: 'c1' },
  );
  assert.ok(r);
  assert.equal(r!.targetClaimId, 'c2');
});

test('validateFollowup：模型编了一个不存在的 id → 作废（宁可少问一次，不用假锚点）', () => {
  const r = validateFollowup(
    { question: '那分母到底是什么', target_claim_id: 'c_99', resolved: false },
    { allowedIds: ALLOWED, currentClaimId: 'c1' },
  );
  assert.equal(r, null);
});

test('validateFollowup：追同一主问的 claim → 允许（咬住不放是追问的本义）', () => {
  const r = validateFollowup(
    { question: '你刚才说的分层抽样，每层抽了多少', target_claim_id: 'c1', resolved: false },
    { allowedIds: new Set(['c2', 'c3']), currentClaimId: 'c1' },
  );
  assert.ok(r, '全局去重管的是主问之间，不该把追问打死');
  assert.equal(r!.targetClaimId, 'c1');
});

test('validateFollowup：id 带引号/空格 → 规整后仍通过', () => {
  const r = validateFollowup(
    { question: '那分母到底是什么', target_claim_id: ' "c2" ', resolved: false },
    { allowedIds: ALLOWED, currentClaimId: 'c1' },
  );
  assert.ok(r);
  assert.equal(r!.targetClaimId, 'c2', '落库必须是干净的 id，不能带引号');
});

test('validateFollowup：followup 为 null → 不追问', () => {
  assert.equal(validateFollowup(null, { allowedIds: ALLOWED, currentClaimId: 'c1' }), null);
});

test('validateFollowup：问题太短(<6) → 作废（"是吗"这种算不上一句追问）', () => {
  const r = validateFollowup(
    { question: '是吗', target_claim_id: 'c2', resolved: false },
    { allowedIds: ALLOWED, currentClaimId: 'c1' },
  );
  assert.equal(r, null);
});

test('validateFollowup：空 id → 作废', () => {
  const r = validateFollowup(
    { question: '那分母到底是什么', target_claim_id: '  ', resolved: false },
    { allowedIds: ALLOWED, currentClaimId: 'c1' },
  );
  assert.equal(r, null);
});

// ─────────────────────────── round 口径 ───────────────────────────

test('roundOfSeq：主问的 round = 主问序号（1 起）', () => {
  assert.equal(roundOfSeq(1, 'question', 0, 1, 3), 1);
  assert.equal(roundOfSeq(4, 'question', 3, 1, 3), 4);
});

test('roundOfSeq：追问继承所属主问的 round', () => {
  // 第 3 个主问已问完（mainsBefore=3），此时落一条追问 → round 应为 3
  assert.equal(roundOfSeq(4, 'followup', 2, 1, 3), 2);
  assert.equal(roundOfSeq(5, 'followup', 3, 1, 3), 3);
});

test('roundOfSeq：mainsBefore=0 时追问的 round 至少为 1（不出现 round 0）', () => {
  assert.equal(roundOfSeq(1, 'followup', 0, 1, 3), 1);
});

test('roundOfLegacy：round 非正数 → 兜底为 1', () => {
  assert.equal(roundOfLegacy({ seq: 1, round: 0 }, 3, 1), 1);
});

test('roundOfLegacy：合理的旧 round 原样保留（不擅自纠正历史数据）', () => {
  // quick: judges=3, mainsEach=1 → maxMains=3。round=2 在范围内，保留。
  assert.equal(roundOfLegacy({ seq: 3, round: 2 }, 3, 1), 2);
});

test('roundOfLegacy：round 明显超出主问总数 → 用 ceil(seq/judges) 兜底', () => {
  // round=99 是不可能的（quick 只有 3 个主问）→ 退回旧口径
  assert.equal(roundOfLegacy({ seq: 6, round: 99 }, 3, 1), 2);
});
