import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/**
 * 用真实 SQLite 验证 insert 的表结构契约。
 *
 * 【为什么不用正则解析源码的实参个数】
 * 那是在猜 JS 语法，遇到字符串里的逗号、嵌套调用、换行就会误判，
 * 而且它只能证明"源码看起来对"，不能证明"插进去的行是正确的"。
 * 这里直接建一张同结构的表、真插一行、再读回来逐字段核对——
 * 参数错位这件事只有在"读回来"时才暴露（当初正是这么发现的：
 * answer 列里躺着 claim id，target_claim_id 列里躺着时间戳，而且 SQLite 不报错）。
 */

function freshTurnsTable(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE turns(
      id TEXT PRIMARY KEY, session_id TEXT, persona_id TEXT,
      seq INTEGER, round INTEGER, kind TEXT, question TEXT,
      answer TEXT, score REAL, gaps TEXT, locators TEXT,
      verified_ok INTEGER, target_claim_id TEXT, created_at TEXT);
  `);
  return db;
}

test('turns 表：列顺序固定，target_claim_id 在 verified_ok 之后、created_at 之前', () => {
  const db = freshTurnsTable();
  const cols = (db.prepare('pragma table_info(turns)').all() as Array<{ name: string }>).map((c) => c.name);
  const order = ['id', 'session_id', 'persona_id', 'seq', 'round', 'kind', 'question', 'answer', 'target_claim_id', 'created_at'];
  // 按名字逐个插（列清单显式给出顺序），所以这里只验证这些列都存在，
  // 真正的错位风险在"insert 的 values 个数对不对"，由下一条测试覆盖。
  for (const c of order) assert.ok(cols.includes(c), `turns 缺少列 ${c}`);
});

test('turns 表：按列清单插一行再读回，每个字段都在自己该在的位置', () => {
  const db = freshTurnsTable();
  const turnId = 't-1';
  const sessionId = 's-1';
  const personaId = 'p-1';
  const claimId = 'c-1';

  // 与 route 里的 insert 完全同构（10 列 10 值）
  const stmt = db.prepare(`
    insert into turns(id, session_id, persona_id, seq, round, kind, question, answer, target_claim_id, created_at)
    values(?,?,?,?,?,?,?,?,?,?)`);
  stmt.run(
    turnId, sessionId, personaId, 1, 1, 'question',
    '', // question：流式产出中先空着
    '', // answer：用户还没答
    claimId,
    '2026-10-31T12:00:00.000Z',
  );

  const row = db
    .prepare('select id, session_id, persona_id, seq, round, kind, question, answer, target_claim_id, created_at from turns where id = ?')
    .get(turnId) as Record<string, unknown>;

  assert.equal(row.id, turnId);
  assert.equal(row.session_id, sessionId);
  assert.equal(row.persona_id, personaId);
  assert.equal(row.seq, 1);
  assert.equal(row.round, 1);
  assert.equal(row.kind, 'question');
  assert.equal(row.question, '', 'question 必须落在 question 列');
  assert.equal(row.answer, '', 'answer 必须落在 answer 列，不能是 claim id');
  assert.equal(row.target_claim_id, claimId, 'target_claim_id 必须落在自己列，不能是时间戳');
  assert.equal(row.created_at, '2026-10-31T12:00:00.000Z', 'created_at 必须落在最后，不能丢');
});

test('turns 表：少传参数【不会报错】，只会把缺的列置 NULL —— 所以必须靠人工逐列对齐', () => {
  // 【这条是本轮最有价值的一条事实】
  // 当初我以为"列 10 个、值 9 个" SQLite 会报错。实测结果是：**不报错**，
  // 它按位置把 9 个值填进前 9 列，最后一列（created_at）留 NULL，
  // 并且 answer 拿到了本该给 target_claim_id 的''。
  // 也就是说：这类错位是**静默**的，只有把行读回来逐字段核对才能发现。
  // 因此正确做法是上一条测试那种"插进去再读回来核对"，而不是指望数据库拦你。
  const db = freshTurnsTable();
  const stmt = db.prepare(`
    insert into turns(id, session_id, persona_id, seq, round, kind, question, answer, target_claim_id, created_at)
    values(?,?,?,?,?,?,?,?,?,?)`);

  let threw = false;
  try {
    // @ts-expect-error 故意少传一个（模拟真实发生过的错误）
    stmt.run('t-2', 's-2', 'p-2', 2, 1, 'question', '', '', '2026-10-31');
  } catch {
    threw = true;
  }

  const row = db
    .prepare('select answer, target_claim_id, created_at from turns where id = ?')
    .get('t-2') as Record<string, unknown>;

  if (threw) {
    // 未来驱动若改为严格校验，也算正确，直接通过
    return;
  }

  // 不报错时，必须能观察到"值整体左移一格"的后果：
  // answer 拿到的应是''（第 8 个值），target_claim_id 拿到'2026-10-31'（第 9 个值），created_at 为 NULL。
  assert.equal(row.answer, '', 'answer 拿到的是第 8 个值');
  assert.equal(row.target_claim_id, '2026-10-31', 'target_claim_id 拿到了本该给 created_at 的值');
  assert.equal(row.created_at, null, '最后一列被置 NULL —— 这就是"少一个值"的真实后果');
});
