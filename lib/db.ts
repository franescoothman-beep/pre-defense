// lib/db.ts —— node:sqlite 连接 + 8 表 + `q` 统一出口
//
// 业务层只走 q.*，绝不直接碰驱动（将来换回 better-sqlite3 只改这个文件）。
//
// 【为什么连接是懒的】
// Next 构建期会 import 每个路由模块来「收集页面数据」，而模块一旦在顶层建连接，
// 构建器就会真的去开库。多个 worker 同时 import 同一个文件，第一个在跑
// `PRAGMA journal_mode = WAL`（要独占写锁），其余立刻报 `database is locked`。
// 这不是构建环境的怪癖——生产环境多进程启动时同样会撞上。
// 所以：**模块顶层什么都别做**，第一次真正 q.* 调用时才建连接。

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const g = globalThis as unknown as { __db?: DatabaseSync };

/** 抢锁等待上限（毫秒）。并发启动时别的进程正在建表，等它一会儿比直接失败好。 */
const BUSY_TIMEOUT_MS = 5000;

function open(): DatabaseSync {
  const dir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(path.join(dir, 'app.db'));

  // ① 先设等待时间，再碰任何需要写锁的东西（顺序反了就等于没设）
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA foreign_keys = ON;');

  // ② WAL 是「切一次就一直有效」的持久属性，读它先看是否已经是 WAL：
  //    已是 WAL 就完全不必再去抢写锁（多进程启动时这一步最容易撞车）。
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
  if (!mode || String(mode.journal_mode).toLowerCase() !== 'wal') {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // 别的进程正好在切：它切完对我也是一样的结果，继续（busy_timeout 之外的最后一道兜底）
    }
  }

  db.exec(`
  CREATE TABLE IF NOT EXISTS documents(
    id TEXT PRIMARY KEY, name TEXT, path TEXT, pages INTEGER, chars INTEGER,
    mode TEXT, density TEXT, status TEXT, content_hash TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS blocks(
    id TEXT PRIMARY KEY, doc_id TEXT, idx INTEGER,
    page INTEGER, section TEXT, text TEXT, char_len INTEGER);

  CREATE TABLE IF NOT EXISTS claims(
    id TEXT PRIMARY KEY, doc_id TEXT, type TEXT, text TEXT,
    block_idx INTEGER, page INTEGER, section TEXT, quote TEXT,
    locator_kind TEXT DEFAULT 'quote',
    scope TEXT,
    verified INTEGER, risk INTEGER, dimension TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS personas(
    id TEXT PRIMARY KEY, doc_id TEXT, name TEXT, role TEXT,
    focus TEXT, tone TEXT, color TEXT, dimension TEXT, session_id TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, doc_id TEXT, mode TEXT, drill_from TEXT,
    state TEXT, started_at TEXT, ended_at TEXT);

  CREATE TABLE IF NOT EXISTS turns(
    id TEXT PRIMARY KEY, session_id TEXT, persona_id TEXT,
    seq INTEGER, round INTEGER, kind TEXT, question TEXT,
    answer TEXT, score REAL, gaps TEXT, locators TEXT,
    verified_ok INTEGER, target_claim_id TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS reports(
    session_id TEXT PRIMARY KEY, material_risk TEXT, performance TEXT,
    coverage TEXT, high_risk TEXT, advice TEXT,
    prev_session_id TEXT, delta TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS llm_logs(
    id TEXT PRIMARY KEY, phase TEXT, model TEXT, prompt_hash TEXT,
    tokens INTEGER, latency_ms INTEGER, ok INTEGER, created_at TEXT);
  `);

  // 【列级迁移】CREATE TABLE IF NOT EXISTS 不会给**已存在的表**补列，
  // 所以新增字段必须在这里显式 ALTER。漏了它的表现是：
  // 开发机上"新库能跑、旧库报 no such column"，而评委/用户机器上一定是旧库。
  // target_claim_id：这一问打在哪个质疑点上（SSE 的 meta 与「扫读原文」都靠它）。
  ensureColumn(db, 'turns', 'target_claim_id', 'TEXT');
  // session_id：人设属于"这一场会话"，不属于材料。旧库补列后该列为 NULL，
  // 读取侧对 NULL 做兜底（见 lib/session.ts），保证老数据不炸。
  ensureColumn(db, 'personas', 'session_id', 'TEXT');
  // dimension：这位评委盯哪个面。排席位时就算出来了，必须存下——
  // 否则读取侧只能"按 color 反查"或"按首问 claim 猜"，两者都会在四维传统色一改时错位。
  ensureColumn(db, 'personas', 'dimension', 'TEXT');
  // content_hash：文件字节的 sha256。
  // 用途有二：① 演示模式判定"是不是内置样例"的持久化依据；
  // ② 材料列表按内容去重 —— 同一份文件反复上传会产生多个 docId（每次 UUID 都不同），
  //    列表里就会出现一排一模一样的名字，看起来像系统在重复造数据。
  ensureColumn(db, 'documents', 'content_hash', 'TEXT');

  return db;
}

/**
 * 幂等加列：表里没有这一列时才 ALTER。
 * 用 pragma table_info 判断而不是"try/catch ALTER"，
 * 因为后者会把真正的语法错误也一并吞掉。
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: string }>;
  if (cols.some((c) => String(c.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** 取连接：首次调用才建，之后复用进程内单例（dev 热重载也复用 globalThis） */
function conn(): DatabaseSync {
  return g.__db ?? (g.__db = open());
}

type Row = Record<string, unknown>;

export const q = {
  all: (sql: string, ...p: unknown[]) => conn().prepare(sql).all(...(p as never[])) as Row[],
  get: (sql: string, ...p: unknown[]) => conn().prepare(sql).get(...(p as never[])) as Row | undefined,
  run: (sql: string, ...p: unknown[]) => conn().prepare(sql).run(...(p as never[])),
  /** 显式建连接（health 自检、脚本预热用）；业务代码不需要调 */
  init: () => conn(),
};

/**
 * 批量写入：把「几十到几千次 insert」压进一个事务。
 * 不用事务的话，几千块文本会各自 commit 一次，慢到肉眼可见，且在 WAL 下产生大量帧。
 */
export function tx<T>(fn: () => T): T {
  const db = conn();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败不该盖住原始错误 */
    }
    throw e;
  }
}
