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
    mode TEXT, density TEXT, status TEXT, created_at TEXT);

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
    focus TEXT, tone TEXT, color TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, doc_id TEXT, mode TEXT, drill_from TEXT,
    state TEXT, started_at TEXT, ended_at TEXT);

  CREATE TABLE IF NOT EXISTS turns(
    id TEXT PRIMARY KEY, session_id TEXT, persona_id TEXT,
    seq INTEGER, round INTEGER, kind TEXT, question TEXT,
    answer TEXT, score REAL, gaps TEXT, locators TEXT,
    verified_ok INTEGER, created_at TEXT);

  CREATE TABLE IF NOT EXISTS reports(
    session_id TEXT PRIMARY KEY, material_risk TEXT, performance TEXT,
    coverage TEXT, high_risk TEXT, advice TEXT,
    prev_session_id TEXT, delta TEXT, created_at TEXT);

  CREATE TABLE IF NOT EXISTS llm_logs(
    id TEXT PRIMARY KEY, phase TEXT, model TEXT, prompt_hash TEXT,
    tokens INTEGER, latency_ms INTEGER, ok INTEGER, created_at TEXT);
  `);
  return db;
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
