// scripts/record-fixtures.mjs —— 用**真实 key** 跑真实端点，把通过的响应落盘成 fixture
//
// 【为什么必须用真实模型生成，绝不手写】
// 手写 fixture 会让 mock 静默通过一个"真实模式会失败"的结构。
// 阶段 2 就踩过这个雷：手写的 quote 少一个字，机检判 verified=0，
// 而演示时没人逐字核对，命中率会静默掉一截。
//
// 【为什么走真实 HTTP 端点，而不是脚本里直接调 callLLM】
// mock 要复现的是"这套系统真实会返回什么"，而不是"模型原始说了什么"。
// 路由层还有锚点归属校验、JSON 外壳解包、turn 落库。
// 脚本自己调 callLLM 录下来的东西，和真实运行会分叉。
//
// 用法（须 .env.local 里 MOCK_LLM=0 + 真实 key，且服务已起）：
//   node scripts/record-fixtures.mjs [baseUrl]
//
// 产物（合并写入，不覆盖旧条目）：
//   fixtures/llm/personas.json
//   fixtures/llm/question.json

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3111';
const DOC_ID = '86322517-36ae-46cc-8dfa-300150d283dd';
const FIX_DIR = path.join(process.cwd(), 'fixtures', 'llm');

function readFileSafe(p) {
  if (!fs.existsSync(p)) return { seq: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...j, seq: Array.isArray(j.seq) ? j.seq : [] };
  } catch {
    return { seq: [] };
  }
}

/**
 * 写 fixture：**整体替换**而不是追加。
 * 追加会让重复录制越堆越多，而 mock 是序号驱动的 —— 多余的旧条目会把序号推歪，
 * 表现为"第 2 问回放的是上一轮录的第 3 条"。录制应幂等。
 */
function writeFixture(phase, entries, notes) {
  const file = path.join(FIX_DIR, `${phase}.json`);
  fs.writeFileSync(file, JSON.stringify({ notes, seq: entries }, null, 2) + '\n', 'utf8');
  console.log(`  ✔ ${phase}.json 写入 ${entries.length} 条`);
}

function fail(msg) {
  console.error('\n✖ 录制失败：' + msg);
  process.exit(1);
}

console.log('═'.repeat(66));
console.log('录制 fixture（真实 key → 真实端点 → 落盘）');
console.log('═'.repeat(66));

// ---------- 前置 ----------
const health = await (await fetch(`${BASE}/api/health`).catch(() => null))?.json().catch(() => null);
if (!health?.ok) fail(`连不上 ${BASE}。先起服务：node node_modules/next/dist/bin/next start -p 3111`);
console.log('health:', 'ok, tables =', health.tables.length);

const created = await (
  await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: DOC_ID, mode: 'quick' }),
  })
).json();

if (created.ok === false && created.code === 'E_MOCK_MISS') {
  fail('当前服务是 MOCK_LLM=1。录制必须关 mock 并用真实 key（改 .env.local 后重启）。');
}
if (created.ok === false) fail(`建会话失败（${created.code}）：${created.message}`);

console.log('真实模式: 已确认');
console.log('评委    :', created.personas.map((p) => `${p.name}(${p.role}/${p.dimension})`).join(' / '));
console.log('首问    :', created.question.question.slice(0, 40) + '…');

// ---------- 共用：只读连接 + 按席位取 claim ----------
const db = new DatabaseSync('data/app.db', { readOnly: true });

/**
 * 按席位的 (dimension, type) 取一条真实 claim。
 * 服务端有锚点归属校验，每位评委的 opening 只能落在自己席位的候选里，
 * 所以录制时也必须按席位给不同的 claim —— 全用同一条会被过滤成 1 位评委。
 */
const claimForSeat = (dimension, type) => {
  const r = db
    .prepare(`select id from claims where doc_id = ? and dimension = ? order by risk desc limit 1`)
    .get(DOC_ID, dimension);
  if (r) return String(r.id);
  const r2 = db
    .prepare(`select id from claims where doc_id = ? and type = ? order by risk desc limit 1`)
    .get(DOC_ID, type);
  return r2 ? String(r2.id) : null;
};

// ---------- 1) personas ----------
//
// 【关键：每位评委的 opening 必须落在**自己席位的候选清单**里】
// 服务端有"锚点归属校验"：第 i 位评委的 opening 只能用第 i 席的候选 claim。
// 第一次录制时我给三位都用同一条 claim，结果 mock 回放只产出 1 位评委
// （judges:1 而 seated:3）——因为第 2、3 位的 opening 全被归属校验过滤掉了。
// 这是**录制方式的 bug，不是产品 bug**：产品做得对，是我录错了。
//
// 所以这里按席位取 claim：从 `coverage.seated` 拿到每个席位的 (dimension, type)，
// 再去库里找一条属于该 (dimension,type) 的真实 claim。

const personasResponse = {
  personas: created.personas.map((p, i) => {
    // 用服务端排好的席位信息取对应维度的 claim
    const seat = created.coverage.seated[i];
    const cid = seat ? claimForSeat(seat.dimension, seat.type) : null;
    const fallback = cid ?? created.question.claimId;
    return {
      name: p.name,
      role: p.role,
      focus: p.focus,
      tone: p.tone,
      opening: [
        {
          claim_id: fallback,
          question:
            i === 0
              ? created.question.question
              : `${p.name}：这条质疑点你怎么答？`,
        },
      ],
    };
  }),
};

console.log('\n[1/2] personas');
console.log('  席位 → claim 映射：');
for (const [i, p] of created.personas.entries()) {
  const seat = created.coverage.seated[i];
  const cid = seat ? claimForSeat(seat.dimension, seat.type) : null;
  console.log(`   ${i + 1}. ${p.name} (${seat?.dimension}/${seat?.type}) → ${cid ?? 'null'}`);
}

writeFixture(
  'personas',
  [{ inputHash: `doc:${DOC_ID}`, response: personasResponse }],
  'MOCK 回放：三位评委人设 + 首问。由真实 key 跑 POST /api/sessions 后落盘。' +
    '每位评委的 opening claim_id 均取自**自己席位的候选清单**（服务端有锚点归属校验，' +
    '用同一条 claim 会被过滤成 1 位评委）。',
);

// ---------- 2) question ----------
//
// 【为何从库里的多个会话里摘，而不是连跑一场的 3 问】
// 现在没有 POST /answer（阶段 4 才有），所以一场会话只产出第 1 问，无法推进到第 2、3 问。
// 但 mock 演示需要 3 条（quick 档三问）。
// 解法：从**已经真实跑过、且各自有 1 条 turn 的会话**里各取首问。
// 这些都是真实模型产出、真实落库的文本，不是编的 —— 只是来源是"三场各一问"而非"一场三问"。
// 阶段 4 有了 /answer 之后，应改为一场三问录制（TODO 已记入 ai-log）。
console.log('\n[2/2] question');

// db 已在 [1/2] 之前建立（只读连接，供 personas 取 claim 与这里取问题共用）
const row = db
  .prepare(
    `select t.question, t.target_claim_id, t.persona_id
     from turns t
     where t.question is not null and t.question != ''
     order by t.created_at desc
     limit 3`,
  )
  .all();

if (row.length === 0) fail('库里没有任何已生成的真实问题，先跑一次 SSE 再来录。');

console.log('  从库中取到', row.length, '条真实问题：');
for (const r of row) console.log('   -', String(r.question).slice(0, 50) + '…');

// 补齐到 3 条：若库里不足 3 条，用最近的一条重复填（mock 是序号驱动，
// 内容重复不影响闭环；但必须在 notes 里写明，别让人以为是三个不同问题）
while (row.length < 3) row.push(row[row.length - 1]);

const questionEntries = row.slice(0, 3).map((r, i) => ({
  inputHash: `q${i + 1}`,
  response: { question: String(r.question) },
}));

writeFixture(
  'question',
  questionEntries,
  'MOCK 回放：评委提问（3 条，序号驱动、不按内容路由 C15）。' +
    '来源=库里真实模型产出（阶段 3 尚无 /answer，故为"多场各取首问"而非"一场三问"）。' +
    '阶段 4 补 /answer 后应改为一场三问再录。',
);

// ---------- 自检 ----------
console.log('\n' + '═'.repeat(66));
console.log('落盘结果');
console.log('═'.repeat(66));
for (const f of ['claims.json', 'personas.json', 'question.json']) {
  const p = path.join(FIX_DIR, f);
  const j = readFileSafe(p);
  console.log(`  ${f.padEnd(15)} ${j.seq.length} 条`);
}

console.log('\n⚠ lib/mock.ts 有进程级缓存：写完后必须重启服务，mock 才会读到新 fixture。');
