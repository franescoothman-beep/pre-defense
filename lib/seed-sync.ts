// lib/seed-sync.ts —— 把「内置样例」的 claim 维度/类型对齐回种子（演示模式专用）
//
// 【这个文件要解决的那一类事故】
// 2026-11-15 录制前实测：用户在质疑点页点了一次「重新抽取」，再开质询，
// 界面上只剩 1 位评委、总共只有 1 问（座位 1/1、第 1/1 问）。
// 根因不是模型抽坏了，而是**席位顺序被分布漂移改了**：
//   planSeats（lib/prompts/personas.v1.ts）按 (dimension,type) 计数排席位、维度按 claim 数降序。
//   种子是 evidence 7 / depth 6 / logic 4 → 席位 [evidence·method, depth·engineering, logic·value]
//   = 陈评委 / 许教授 / 周评委，正好是 fixtures/llm/personas.json 的录制序。
//   而 mock 重抽回放的是 fixtures/llm/claims.json，它把 2 条 claim 判成了 logic/method，
//   于是库内变成 evidence 7 / logic 6 / depth 4 → 席位 [evidence·method, logic·value, depth·engineering]。
//   app/api/sessions/route.ts 是「第 i 位评委 ↔ 第 i 席」按**下标**对齐的，
//   许/周的 opening claim_id 一旦落不进自己的席位候选，就被 filter 掉 → validated 只剩 1 位。
//
// 【为什么修「维度对齐」而不是改「对齐方式」】
// 只把对齐改成按内容匹配，能让 3 位评委都留下来，但**上场顺序会变成 陈/周/许**，
// 而问题文本是 fixtures/llm/question.json 按序号回放的（q1→q2→q3，C15 序号驱动），
// 两者一错位就变成「周评委在问兜底、许教授在问推广」，画面照样是错的。
// 所以必须让席位序**回到录制时那一版**，也就是让库内分布回到种子。
//
// 【只 UPDATE 两列、不删不插】
// block_idx / quote / risk / verified 是锚点与机检结果，动了溯源就废；
// 只改 dimension/type 这两个「可再判」的标签，且仅对内置样例生效。

import fs from 'node:fs';
import path from 'node:path';
import { q, tx } from './db';

/** 种子文件位置（相对仓库根；与 scripts/demo.mjs 用的是同一份） */
export const SEED_PATH = path.join(process.cwd(), 'scripts', 'seed-demo-data.json');

export type DemoSeed = {
  doc: {
    id: string;
    name: string;
    content_hash?: string | null;
    [k: string]: unknown;
  };
  blocks: Array<{ idx: number; text: string; [k: string]: unknown }>;
  claims: Array<{
    id: string;
    dimension: string;
    type: string;
    [k: string]: unknown;
  }>;
};

let cachedSeed: DemoSeed | null = null;

/**
 * 读种子（惰性 + 进程内缓存）。
 *
 * 缓存是安全的：种子是仓库资产，运行期不会变。
 * 读不到时返回 null（演示模式以外、或没把种子带上的部署），调用方一律当「不适用」处理。
 */
export function demoSeed(): DemoSeed | null {
  if (cachedSeed) return cachedSeed;
  try {
    cachedSeed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')) as DemoSeed;
    return cachedSeed;
  } catch {
    console.warn(`[seed-sync] 未找到种子文件：${SEED_PATH}（跳过维度对齐）`);
    return null;
  }
}

/** 测试用：清缓存 */
export function resetDemoSeedCache(): void {
  cachedSeed = null;
}

/**
 * 这份材料是不是内置样例。
 *
 * 判据用**内容指纹**（与 lib/demo.ts 同一思路）：docId 每次上传都会变，
 * 只有文件字节的哈希是稳定的。也接受 docId 直接等于种子里记录的 id
 * （demo.mjs 灌种时用的就是它）。
 */
export function isDemoDoc(docId: string, seedIn?: DemoSeed | null): boolean {
  const seed = seedIn ?? demoSeed();
  if (!seed) return false;
  const row = q.get('select id, content_hash from documents where id = ?', docId);
  if (!row) return false;
  if (String(row.id) === seed.doc.id) return true;
  const live = row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash);
  return Boolean(live && seed.doc.content_hash && live === seed.doc.content_hash);
}

export type DimDrift = { id: string; dimension: string; type: string };

/** 算出库内与种子的 (dimension,type) 漂移项（不写库，便于诊断脚本复用） */
export function diffDemoClaimDims(docId: string, seedIn?: DemoSeed | null): DimDrift[] {
  const seed = seedIn ?? demoSeed();
  if (!seed) return [];
  const liveRows = q.all('select id, dimension, type from claims where doc_id = ?', docId);
  const seedById = new Map(seed.claims.map((c) => [c.id, c]));
  const drift: DimDrift[] = [];
  for (const r of liveRows) {
    const s = seedById.get(String(r.id));
    if (s && (String(r.dimension) !== s.dimension || String(r.type) !== s.type)) {
      drift.push({ id: String(r.id), dimension: s.dimension, type: s.type });
    }
  }
  return drift;
}

/**
 * 把内置样例的 claim 维度/类型按种子对齐。
 *
 * @returns 对齐了的条数；0 表示本就一致或不是内置样例；-1 表示执行失败（已回滚）
 */
export function syncDemoClaimDims(docId: string): number {
  const seed = demoSeed();
  if (!seed) return 0;
  if (!isDemoDoc(docId, seed)) return 0;

  const drift = diffDemoClaimDims(docId, seed);
  if (drift.length === 0) return 0;

  try {
    tx(() => {
      for (const d of drift) {
        q.run('update claims set dimension = ?, type = ? where id = ?', d.dimension, d.type, d.id);
      }
    });
    return drift.length;
  } catch (e) {
    console.warn('[seed-sync] 对齐 claim dimension/type 失败（已回滚，不影响真实模式）：', e);
    return -1;
  }
}
