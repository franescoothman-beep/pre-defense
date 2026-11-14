// scripts/test-fixtures.mjs —— 用「当前」schema 校验全部回放剧本
//
// 【这个脚本存在的理由】
// 回放数据是硬编码 JSON。一旦 lib/schemas.ts 收紧字段（改名字、加 min、
// 把 locator 从字符串改成对象），旧 fixture 不会自己报错 —— 它只会在
// 演示那一刻抛 E_SCHEMA「回放数据不符合当前结构约定」，而演示往往就是录屏／评审。
// 所以规矩是：**改完 prompt 或 schema 必须跑 npm run test:fixtures**。
//
// 【校验分四层，缺一不可】
//   1. 结构层：每条 response 过 lib/schemas.ts 里对应的 zod schema（与运行时同一份）
//   2. 机检层：fixture 里的 locator 必须能过 lib/locator.ts 的逐字／scope 机检
//      —— 只过 zod 是不够的：zod 只管"字段形状"，管不了"quote 是否真的在原文里"
//   3. 跨条层：personas 三位评委的 opening claim_id 必须互不相同
//      （服务端有锚点归属校验，同一条 claim 会让 3 位评委被过滤成 1 位）
//   4. 锚点层：fixture 里引用的 claim_id 必须都在 demo 种子里
//      —— 前三层全绿也可能在演示时 502：种子与 fixture 是两份硬编码，
//      任何一次「重新抽取」把库里 claim id 换成新 UUID，personas 就一条也对不上
//      （11-03、11-14 各踩过一次）。这一层把"脱钩"挡在提交之前。
//
// 用法：
//   node scripts/test-fixtures.mjs
//   npm run test:fixtures
//
// 退出码：0 = 全绿；1 = 有任何一条不过。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';

// 产品代码为了兼容 Next 的 bundler，相对导入不带扩展名（`import { norm } from './normalize'`）。
// 裸跑 Node 时这会 ERR_MODULE_NOT_FOUND，所以这里挂上跟 tests/hooks.mjs 同一套解析钩子，
// 让脚本可以 `node scripts/test-fixtures.mjs` 直接跑，不必记 `--import` 参数。
// 注意：钩子必须在 import 产品代码**之前**注册，所以 lib 的导入走下面的动态 import。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {
          /* 试下一个后缀 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { ClaimsOut, PersonasOut, QuestionOut, EvaluateOut, ReportOut } = await import('../lib/schemas.ts');
const { verifyQuote, verifyAbsence } = await import('../lib/locator.ts');

const FIX_DIR = path.join(process.cwd(), 'fixtures', 'llm');
const BLOCKS_FILE = path.join(process.cwd(), 'fixtures', 'demo', 'sample-paper.blocks.json');

/** phase → { schema, 人话名 }。新增 phase 必须在这里登记，否则脚本会当成未知文件报错。 */
const PHASES = {
  claims: { schema: ClaimsOut, label: '质疑点抽取' },
  personas: { schema: PersonasOut, label: '评委席位' },
  question: { schema: QuestionOut, label: '提问' },
  evaluate: { schema: EvaluateOut, label: '判分与追问' },
  report: { schema: ReportOut, label: '报告' },
};

/** 演示模式的固定材料。fixture 里的 blockIdx 全部指向这份文档。 */
const BLOCKS = JSON.parse(readFileSync(BLOCKS_FILE, 'utf8')).blocks;

const failures = [];
const notes = [];
let checks = 0;

function fail(where, msg) {
  failures.push(`${where}：${msg}`);
}

function ok(where, msg) {
  checks += 1;
  notes.push(`  ✓ ${where}${msg ? ` — ${msg}` : ''}`);
}

/** zod 报错压成一行，方便在终端里读 */
function brief(err) {
  return (err?.issues ?? [])
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join(' | ');
}

/**
 * 机检一条 locator。
 * 与运行时 lib/locator.ts 完全一致：quote 走逐字命中，absence 走 scope 合法性。
 * blockIdx 为 -1 表示"模型没标位置"（ReportLocatorIn 会把它规整成 -1），
 * 这类不做逐字机检 —— 报告里的 locator 本来就可能没有位置，运行时也是计 0 不丢。
 */
function checkLocator(where, loc, { strict = true } = {}) {
  const kind = loc.kind;
  const blockIdx = Number(loc.blockIdx ?? loc.block_idx ?? -1);

  if (kind === 'absence') {
    const r = verifyAbsence(BLOCKS, loc.scope, blockIdx >= 0 ? blockIdx : 0);
    // absence 在 scope 缺省时 verified=null 且 reason 说明"未给 scope"，运行时按未通过统计
    if (r.verified === null && !loc.scope) {
      fail(where, `absence 没有 scope（${r.reason}）`);
      return;
    }
    ok(where, `absence · ${r.reason}`);
    return;
  }

  if (blockIdx < 0) {
    // 报告里允许"位置未标注"：运行时 attachReportLocator 会给 verified=0 并计入分母
    if (strict) {
      fail(where, 'quote 类 locator 没有 blockIdx');
      return;
    }
    ok(where, 'quote · 位置未标注（报告允许）');
    return;
  }

  const r = verifyQuote(BLOCKS, blockIdx, loc.quote ?? '');
  if (r.verified === 1) {
    ok(where, `quote 命中${r.movedBy ? `（邻域 +${r.movedBy}）` : ''}`);
  } else {
    fail(where, `quote 未命中：${r.reason} · quote=「${String(loc.quote ?? '').slice(0, 40)}」`);
  }
}

/** 从一份 response 里挖出所有 locator，逐个机检 */
function checkResponseLocators(where, phase, response) {
  if (phase === 'claims') {
    for (const [i, c] of (response.claims ?? []).entries()) {
      checkLocator(`${where} claims[${i}]`, {
        kind: c.kind,
        blockIdx: c.block_idx,
        quote: c.quote,
        scope: c.scope,
      });
    }
  }
  if (phase === 'evaluate') {
    for (const [i, l] of (response.locators ?? []).entries()) {
      checkLocator(`${where} locators[${i}]`, l);
    }
  }
  if (phase === 'report') {
    for (const [i, dim] of (response.material_risk ?? []).entries()) {
      for (const [j, l] of (dim.locators ?? []).entries()) {
        // 报告 locator 允许没有位置（运行时计 0 不丢），所以 strict=false
        checkLocator(`${where} material_risk[${i}].locators[${j}]`, l, { strict: false });
      }
    }
  }
}

// ── 0. 目录存在性 ────────────────────────────────────────────────────────────
if (!existsSync(FIX_DIR)) {
  console.error(`✖ 找不到 ${FIX_DIR}`);
  process.exit(1);
}

const files = readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error(`✖ ${FIX_DIR} 里没有任何 .json`);
  process.exit(1);
}

const seen = new Set();

// ── 1. 逐文件校验 ────────────────────────────────────────────────────────────
for (const file of files) {
  const phase = path.basename(file, '.json');
  const def = PHASES[phase];
  const where = `fixtures/llm/${file}`;

  if (!def) {
    fail(where, `未知 phase「${phase}」——请先在 scripts/test-fixtures.mjs 的 PHASES 里登记对应 schema`);
    continue;
  }
  seen.add(phase);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(FIX_DIR, file), 'utf8'));
  } catch (e) {
    fail(where, `JSON 解析失败：${e.message}`);
    continue;
  }

  const seq = parsed.seq;
  if (!Array.isArray(seq)) {
    fail(where, '缺少 seq 数组');
    continue;
  }
  if (seq.length === 0) {
    fail(where, 'seq 是空的 —— 回放时会直接抛 E_MOCK_MISS');
    continue;
  }
  if (typeof parsed.notes !== 'string' || parsed.notes.trim() === '') {
    fail(where, '缺少 notes（录制说明是给人看的，不许省）');
  }

  ok(where, `${seq.length} 条回放 · ${def.label}`);

  for (const [i, entry] of seq.entries()) {
    const at = `${where} seq[${i}]`;

    if (entry === null || typeof entry !== 'object') {
      fail(at, '条目不是对象');
      continue;
    }
    if (entry.response === undefined) {
      fail(at, '缺少 response');
      continue;
    }
    if (entry.inputHash !== undefined && typeof entry.inputHash !== 'string') {
      fail(at, 'inputHash 存在但不是字符串');
    }

    // 1a. 结构层
    const checked = def.schema.safeParse(entry.response);
    if (!checked.success) {
      fail(at, `schema 不过：${brief(checked.error)}`);
      continue;
    }
    ok(at, 'schema 通过');

    // 1b. 机检层
    checkResponseLocators(at, phase, checked.data);

    // 1c. 各 phase 的额外约定
    if (phase === 'question') {
      const t = checked.data.question;
      if (t.length < 15 || t.length > 60) {
        // schema 允许 6–200，但 question.v1.ts 的 prompt 要求 15–60；
        // 这里只告警不算失败 —— 长一点的问题不会让演示崩
        notes.push(`  ⚠ ${at} 问题长度 ${t.length} 字，超出 prompt 约定的 15–60`);
      }
    }
  }
}

// ── 2. 缺失的 phase ─────────────────────────────────────────────────────────
// 零 key 闭环要求 claims→personas→question→evaluate→report 五段都能回放。
// 少任何一段，demo 就会在那个 phase 抛 E_MOCK_MISS。
for (const phase of Object.keys(PHASES)) {
  if (!seen.has(phase)) {
    fail(`fixtures/llm/${phase}.json`, `缺失 —— 零 key 闭环会在「${PHASES[phase].label}」这一段落空`);
  }
}

// ── 3. 跨条校验：personas 的锚点必须互不相同 ────────────────────────────────
if (seen.has('personas')) {
  const personas = JSON.parse(readFileSync(path.join(FIX_DIR, 'personas.json'), 'utf8'));
  for (const [i, entry] of (personas.seq ?? []).entries()) {
    const list = entry?.response?.personas ?? [];
    const ids = list.map((p) => p?.opening?.[0]?.claim_id).filter((x) => typeof x === 'string');
    if (new Set(ids).size !== ids.length) {
      fail(
        `fixtures/llm/personas.json seq[${i}]`,
        `三位评委的 opening claim_id 有重复（${ids.join(', ')}）—— 服务端锚点归属校验会把重复的评委过滤掉`,
      );
    } else if (ids.length > 0) {
      ok(`fixtures/llm/personas.json seq[${i}]`, `3 位评委锚点互不相同`);
    }
  }
}

// ── 4. 锚点层：fixture 引用的 claim_id 必须都在 demo 种子里 ──────────────────
// 前三层全绿也可能在演示当天 502：种子和 fixture 是两份硬编码，只要库里 claim id
// 被换成新 UUID（例如点一次「重新抽取」），personas 的 opening 就一条也对不上，
// 服务端锚点归属校验会把三位评委全过滤掉，用户看到的是「质询不了了」。
// 这一层把「脱钩」挡在提交之前 —— 11-03、11-14 各踩过一次。
{
  const seedPath = path.join(process.cwd(), 'scripts', 'seed-demo-data.json');
  if (!existsSync(seedPath)) {
    fail('scripts/seed-demo-data.json', '缺失 —— demo 种子里没有 claims，锚点层无从校验');
  } else {
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    const seedIds = new Set((seed.claims ?? []).map((c) => c.id));
    if (seedIds.size === 0) {
      fail('scripts/seed-demo-data.json', 'claims 为空 —— 锚点层无从校验');
    }

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    let stale = 0;
    let scanned = 0;

    for (const phase of Object.keys(PHASES)) {
      const file = path.join(FIX_DIR, `${phase}.json`);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      // 只认「像 claim_id 的」UUID：种子里没有的 docId 也是 36 位 UUID，
      // 但它出现在 persona/query 的 doc 字段上，不该被当成失效锚点。
      const ids = [...new Set(text.match(UUID_RE) ?? [])].filter(
        (id) => id !== seed.doc?.id && id !== seed.doc?.docId,
      );
      scanned += ids.length;
      const missing = ids.filter((id) => !seedIds.has(id));
      if (missing.length > 0) {
        stale += missing.length;
        fail(
          `fixtures/llm/${phase}.json`,
          `${missing.length} 个 claim_id 不在 demo 种子里（${missing.map((m) => m.slice(0, 8)).join(', ')}）` +
            ' —— 演示时这些引用会被静默丢弃，personas 更会直接 502',
        );
      }
    }

    if (stale === 0) {
      ok('锚点层', `${scanned} 个 claim_id 引用全部能在种子里找到`);
    }
  }
}

// ── 5. 汇报 ─────────────────────────────────────────────────────────────────
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
if (verbose) {
  for (const line of notes) console.log(line);
}

console.log('');
console.log(`检查项：${checks} · 失败：${failures.length}`);

if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log(`  ✖ ${f}`);
  console.log('');
  console.log('回放剧本与当前 schema 不一致。改 schema / prompt 后必须同步重录 fixture：');
  console.log('  npm run record:fixtures   # 需真实 key + 已启动的服务');
  process.exit(1);
}

console.log('✓ 全部回放剧本与当前 schema、机检规则一致。');
process.exit(0);
