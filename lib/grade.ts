// lib/grade.ts —— 判分结果的落库前处理（纯函数，不碰 DB、不调模型）
//
// 【为什么判分要单独一层，而不是直接写进路由】
// 判分结果里有两个字段必须先"洗"一遍才敢入库：
//
//   ① `locators` —— 模型给的出处是不可信的（它会给一个看起来对的句子）。
//      必须逐条过 lib/locator.ts 的机检：quote 类要逐字命中（±2 邻域 + 全篇兜底），
//      absence 类要校验 scope 落在已知章节或合法范围。命中不了的**保留**并标 0，
//      进入命中率的分母（见 §3.10「引用命中率的分母含未命中，不剔除」）。
//
//   ② `followup.target_claim_id` —— 模型可能会编一个 id，或者指向已经问过的点。
//      必须过归属校验：不在本场候选清单里 → 这条追问作废。
//      宁可这一轮不追问，也不让评委拿一个假锚点开问——
//      一个对不上原文的追问会当场把这个产品的可信度打穿。
//
// 这两件事都只在"有真实模型输出"时才真正发生，因此只在单测里能钉死它们，
// 在路由里写会让它们变成"跑一次才知道对不对"的逻辑。

import { attachLocator, type LocatorKind } from './locator';
import type { Block } from './parse';

export type RawLocator = {
  kind?: 'quote' | 'absence';
  block_idx: number;
  quote?: string;
  scope?: string;
};

export type GradedLocator = {
  blockIdx: number;
  page: number | null;
  section: string | null;
  quote: string;
  kind: LocatorKind;
  scope?: string;
  /** 机检结果：quote 类 1/0，absence 类 null（不参与逐字命中率） */
  verified: 0 | 1 | null;
  /** 机检给出的判定原因，写进 ai-log 与评测，用于诊断 prompt 质量 */
  reason: string;
  /** 邻域重试移动了几块（>0 说明模型的块号漂了，这是 prompt 质量信号） */
  movedBy: number;
};

/**
 * 洗一遍 locators：越界条目丢弃（保留会让前端点开一片空白），
 * 其余全部保留并带上机检结论。
 *
 * 【为什么越界的要丢而不是标 verified=0】
 * 一个 block_idx 越界的 locator 没有"位置"可言——前端拿它去 blocks 表取原文会拿到空。
 * 保留它就得在 UI 里再写一条"这条例外不能点"，而这个例外永远不会有内容。
 * 而"在界内但没命中"的 locator **必须保留**：那是真的有人引了这句原文只是没对上，
 * 它是产品诚实的证据（分母里要算上它）。
 */
export function gradeLocators(blocks: Block[], raws: RawLocator[]): GradedLocator[] {
  const out: GradedLocator[] = [];
  for (const raw of raws) {
    const kind: LocatorKind = raw.kind === 'absence' ? 'absence' : 'quote';
    const { locator, result } = attachLocator(blocks, {
      kind,
      block_idx: raw.block_idx,
      quote: raw.quote,
      scope: raw.scope,
    });
    if (!locator) continue; // 越界 → 丢弃（上面注释说明了理由）
    out.push({
      blockIdx: locator.blockIdx,
      page: locator.page,
      section: locator.section,
      quote: locator.quote,
      kind: locator.kind,
      scope: locator.scope,
      verified: result.verified,
      reason: result.reason,
      movedBy: result.movedBy,
    });
  }
  return out;
}

/**
 * 一条评价的 `verified_ok` 聚合值。
 *
 * 语义：这条评价**至少有一条出处被机检通过**，才叫"可溯源"。
 *
 * 【为什么不取"全中"】要求全部命中等于要求模型每一条引用都逐字无误——
 * 实测真实 key 下做不到（阶段 2 是 12/12，但判分是长文本自由引用，命中率会更低）。
 * 取"至少一条"是正确的产品口径：一条评价只要有一个站得住的锚点，
 * 用户就能点开那句话判断"这个批评有没有道理"；剩下没命中的仍然如实展示为"未校验"。
 *
 * 【absence 怎么算】absence 不进 quote 分母，也不因逐字未命中而降级：
 * 它只要 scope 合法就算通过（返回 1）。理由：absence 表达的是"这里没有"，
 * 它本来就没有可引用的句子，拿它去跑逐字命中是逻辑错误。
 */
export function verifiedOkOf(locators: GradedLocator[]): 0 | 1 {
  if (locators.length === 0) return 0;
  for (const l of locators) {
    if (l.kind === 'absence') {
      // scope 未落在已知章节时仍算通过：那说明材料本身没有章节结构（flow 模式的 DOCX），
      // 不是模型编了范围。真正该拒的是"没给 scope"，那一步 schema 已经拦掉了。
      if (l.scope && l.scope.trim().length > 0) return 1;
      continue;
    }
    if (l.verified === 1) return 1;
  }
  return 0;
}

/**
 * 追问的归属校验。
 *
 * 返回 `null` 表示这条追问作废（模型编了 id / 指了已问过的点 / 指了不存在于本材料的点）。
 * 返回对象表示通过，并把 `target_claim_id` 规整成**库里真实存在的那个 id**
 * （模型可能给的是带引号或带空格的写法，规整后才好落库）。
 *
 * 【为什么"允许追问同一主问的那条 claim"】
 * 追问的本质就是咬住同一条质疑点再深一层（"你说了 1240 条，那分母是什么"）。
 * 全局去重规则管的是**主问之间**不许重复 targeting，不是追问答不许问同一条。
 * 这两条口径如果混在一起，追问会永远被去重规则打死——quick 档就再也追不出来了。
 * 所以去重检查的基准是「除本主问之外已 targeting 过的 claim」。
 */
export type FollowupInput = {
  question: string;
  target_claim_id: string;
  resolved: boolean;
};

export function validateFollowup(
  followup: FollowupInput | null,
  opts: {
    /** 本场当前可追问的候选 id（已排除其它主问 targeting 过的） */
    allowedIds: Set<string>;
    /** 本主问正在追的那条 claim（允许追问它） */
    currentClaimId: string | null;
  },
): { question: string; targetClaimId: string; resolved: boolean } | null {
  if (!followup) return null;
  const q = followup.question.trim();
  if (q.length < 6) return null;

  // 规整：模型常把 id 写成 `"c_12"` 或 ` c_12 `，去掉引号与空白再比对
  const raw = followup.target_claim_id.trim().replace(/^["'「]|["'」]$/g, '').trim();
  if (!raw) return null;

  const ok = opts.allowedIds.has(raw) || opts.currentClaimId === raw;
  if (!ok) {
    console.warn(
      `[grade] 追问的 target_claim_id 对不上本场候选（${raw}），这条追问作废。` +
        `候选 ${opts.allowedIds.size} 条${opts.currentClaimId ? '，本主问锚点 ' + opts.currentClaimId : ''}。`,
    );
    return null;
  }

  return { question: q, targetClaimId: raw, resolved: followup.resolved };
}

/**
 * 一条主问的轮次归属。
 *
 * 【这个函数存在的理由】turns.round 的语义改过一次（见 lib/state.ts 顶部注释）。
 * 库里已有的旧行是按旧口径（seq/judges 向上取整）写的，直接用会让"本轮追问几次"算错。
 * 新写入的行统一走这里，读取侧再按下面 `roundOfLegacy` 兼容旧值。
 */
export function roundOfSeq(
  seq: number,
  kind: 'question' | 'followup',
  mainsBefore: number,
  mainsEach: number,
  judges: number,
): number {
  void judges;
  if (kind === 'question') return mainsBefore + 1;
  // 追问继承所属主问的 round = 当前已问完的主问序号（至少 1）
  return Math.max(1, mainsBefore);
}

/** 旧数据的 round 兼容：旧口径是 ceil(seq / judges)，这里只在 round 明显不合理时兜底 */
export function roundOfLegacy(row: { seq: number; round: number }, judges: number, mainsEach: number): number {
  const expected = Math.ceil(row.seq / Math.max(1, judges));
  // 新口径下 quick 档 3 问的 round 是 1,2,3；旧口径是 1,1,1。
  // 无法从数据本身判断写它的代码是哪一版，所以不做自动纠正——
  // 只在 round 为非正数或超过主问总数时给出一个可用的替代值。
  if (!Number.isFinite(row.round) || row.round < 1) return 1;
  const maxMains = judges * mainsEach;
  return row.round > maxMains ? expected : row.round;
}
