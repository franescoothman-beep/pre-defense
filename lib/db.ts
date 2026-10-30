import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const g = globalThis as unknown as { __db?: DatabaseSync };

function create(): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
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

export const db = g.__db ?? (g.__db = create());

type Row = Record<string, unknown>;

/** 业务层只走 q.*，绝不直接碰驱动（换回 better-sqlite3 只改这个文件） */
export const q = {
  all: (sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Row[],
  get: (sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as Row | undefined,
  run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[])),
};
