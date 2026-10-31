import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/**
 * 材料列表「按内容去重」的 SQL 契约测试。
 *
 * 用真实 SQLite 跑同一条 SQL，逐行核对 —— 而不是去解析源码字符串。
 *
 * 这条测试来自一个**真实踩到的坑**：
 * 第一次实现按"最新"保留，结果去重后留下的那条 claims=0，
 * 而真正能演示的那条（12 条 claims）被挤掉了 —— 用户点进去发现没有质疑点，
 * 还得重新抽一次。去重的目的是"别让同一份材料占多行"，
 * 不是"把有用的那行删掉"。
 */

/** 建一张同构表并灌入"同一份文件传了 3 次"的场景 */
function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE documents(
      id TEXT PRIMARY KEY, name TEXT, path TEXT, pages INTEGER, chars INTEGER,
      mode TEXT, density TEXT, status TEXT, content_hash TEXT, created_at TEXT);
    CREATE TABLE claims(id TEXT PRIMARY KEY, doc_id TEXT);
  `);

  // 同一份内容（hash 相同）传了 3 次，时间递增；只给"中间那次"挂了 claims
  const H = 'same-hash';
  db.prepare(`insert into documents values(?,?,?,?,?,?,?,?,?,?)`).run(
    'old', 'sample-paper.docx', 'a.docx', null, 373, 'flow', 'thin', 'parsed', H, '2026-10-31T01:00:00Z',
  );
  db.prepare(`insert into documents values(?,?,?,?,?,?,?,?,?,?)`).run(
    'mid', 'sample-paper.docx', 'b.docx', null, 373, 'flow', 'thin', 'parsed', H, '2026-10-31T02:00:00Z',
  );
  db.prepare(`insert into documents values(?,?,?,?,?,?,?,?,?,?)`).run(
    'new', 'sample-paper.docx', 'c.docx', null, 373, 'flow', 'thin', 'parsed', H, '2026-10-31T03:00:00Z',
  );

  // 只有 mid 有 claims（两条）
  db.prepare('insert into claims values(?,?)').run('c1', 'mid');
  db.prepare('insert into claims values(?,?)').run('c2', 'mid');
  return db;
}

const SQL = `
  select d.id, d.name,
    (select count(*) from claims c where c.doc_id = d.id) as claims
  from documents d
  where d.id in (
    select id from (
      select id,
        row_number() over (
          partition by coalesce(content_hash, id)
          order by
            (select count(*) from claims c where c.doc_id = documents.id) desc,
            created_at desc
        ) as rn
      from documents
    )
    where rn = 1
  )
  order by d.created_at desc`;

test('同一内容传 3 次 → 去重后只剩 1 行', () => {
  const db = seed();
  const rows = db.prepare(SQL).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, `同一份文件应只占 1 行，实际 ${rows.length} 行`);
});

test('去重保留的是**有 claims 的那一条**（而不是最新的那条）', () => {
  // 这是本轮的关键回归：按"最新"保留会删掉真正有用的那条。
  const db = seed();
  const rows = db.prepare(SQL).all() as Array<Record<string, unknown>>;
  assert.equal(rows[0].id, 'mid', `应保留有 claims 的 mid，实际保留了 ${rows[0].id}`);
  assert.equal(rows[0].claims, 2, '保留的那条应带着它的 claims');
});

test('同内容且 claims 数相同时 → 保留最新的', () => {
  // 若都有 claims，那"最新"是对的（它挂着最新一次抽取结果）。
  const db = seed();
  db.prepare('insert into claims values(?,?)').run('c3', 'new');
  db.prepare('insert into claims values(?,?)').run('c4', 'new');
  const rows = db.prepare(SQL).all() as Array<Record<string, unknown>>;
  assert.equal(rows[0].id, 'new', 'claims 数相同时应取最新');
});

test('content_hash 为 NULL 的老数据按 id 分组，不会被合并', () => {
  // 迁移前上传的行没有 hash。若不兜底，所有 NULL 会被当成同一组全删掉。
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT, path TEXT, pages INTEGER, chars INTEGER,
      mode TEXT, density TEXT, status TEXT, content_hash TEXT, created_at TEXT);
    CREATE TABLE claims(id TEXT PRIMARY KEY, doc_id TEXT);
  `);
  const ins = db.prepare('insert into documents values(?,?,?,?,?,?,?,?,?,?)');
  ins.run('legacy1', '旧材料A', 'a.docx', null, 100, 'flow', 'thin', 'parsed', null, '2026-10-30T01:00:00Z');
  ins.run('legacy2', '旧材料B', 'b.docx', null, 200, 'flow', 'thin', 'parsed', null, '2026-10-30T02:00:00Z');

  const rows = db.prepare(SQL).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, '两个不同的老材料不能被合并成 1 行');
});

test('不同内容不会被误合并', () => {
  const db = seed();
  db.prepare('insert into documents values(?,?,?,?,?,?,?,?,?,?)').run(
    'other', '其它材料.pdf', 'd.pdf', 10, 5000, 'paged', 'normal', 'parsed', 'diff-hash', '2026-10-31T04:00:00Z',
  );
  const rows = db.prepare(SQL).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, `应保留 2 个不同内容，实际 ${rows.length}`);
});
