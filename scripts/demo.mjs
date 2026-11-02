// scripts/demo.mjs —— 跨平台启动 mock 演示模式（Windows 下 `set VAR=1&&next dev` 很容易写错）
//
// 【为什么这个脚本要在起服务前先"灌"内置样例】
// 演示模式前端**禁用上传**（mockMode → input disabled，见 app/upload/page.tsx），
// 所以 fresh clone 的库是空的时，/api/demo 会返回 E_NO_DEMO_DOC ——
// 用户点"用内置样例开始"，系统说"库里没有样例"，演示走不下去。
//
// 更关键的一点：personas 回放锚定的是**具体 claim_id**。
// 如果 demo 库的 claim 是现场新生成的 UUID，录制好的 personas.json 里的
// opening.claim_id 就指不到任何席位候选 → 评委被丢成 1 位。
// 因此种子必须**原样保留真实抽取时的 claim id / block_idx / quote / dimension / risk**，
// 这样运行时算出的席位与录制时完全一致，mock 回放才接得上。
//
// 灌库是幂等的：只有当库里没有「已抽 claims 的 sample-paper.docx」时才写入，
// 重启不会重复灌、也不会覆盖用户真实模式下上传的数据（演示模式根本不碰上传）。
//
// 【为什么直接复用产品侧 lib/db.ts 建表】
// 库表是 lib/db.ts 里"首次 q.* 调用时才建"的（懒连接，避开构建期多 worker 抢锁）。
// 这里用产品自己的 q/tx 来读写，表自然就建好了，不必把建表语句抄一遍（抄了必漂移）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';

// 允许下面 dynamic import 产品侧 .ts 模块（与 tests/hooks.mjs 同款 resolve 钩子）
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

const { q, tx } = await import('../lib/db.ts');

const cwd = process.cwd();
const SEED = path.join(cwd, 'scripts', 'seed-demo-data.json');
const DEMO_NAME = 'sample-paper.docx';

function seedIfMissing() {
  if (!fs.existsSync(SEED)) {
    console.warn('[demo] 未找到 seed-demo-data.json，跳过内置样例灌库（零 key 演示可能走不通）。');
    return;
  }
  // q.* 的首次调用会触发 lib/db.ts 的 open() 建表，所以这里不用担心"no such table"
  const existing = q.get(
    `select d.id from documents d
     where d.name = ?
     order by (select count(*) from claims c where c.doc_id = d.id) desc, created_at desc
     limit 1`,
    DEMO_NAME,
  );
  const claimed = existing
    ? Number(q.get('select count(*) as n from claims where doc_id = ?', String(existing.id)).n)
    : 0;
  if (claimed > 0) {
    console.log('[demo] 内置样例已就绪，跳过灌库。');
    return;
  }

  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const now = new Date().toISOString();
  try {
    tx(() => {
      q.run(
        `insert into documents(id, name, path, pages, chars, mode, density, status, content_hash, created_at)
         values(?,?,?,?,?,?,?,?,?,?)`,
        seed.doc.id,
        seed.doc.name,
        seed.doc.path,
        seed.doc.pages,
        seed.doc.chars,
        seed.doc.mode,
        seed.doc.density,
        seed.doc.status,
        seed.doc.content_hash,
        now,
      );
      for (const b of seed.blocks) {
        q.run(
          `insert into blocks(id, doc_id, idx, page, section, text, char_len) values(?,?,?,?,?,?,?)`,
          b.id,
          seed.doc.id,
          b.idx,
          b.page,
          b.section,
          b.text,
          b.char_len,
        );
      }
      for (const c of seed.claims) {
        q.run(
          `insert into claims(id, doc_id, type, text, block_idx, page, section, quote,
                              locator_kind, scope, verified, risk, dimension, created_at)
           values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          c.id,
          seed.doc.id,
          c.type,
          c.text,
          c.block_idx,
          c.page,
          c.section,
          c.quote,
          c.locator_kind,
          c.scope,
          c.verified,
          c.risk,
          c.dimension,
          now,
        );
      }
    });
    console.log(
      `[demo] 已灌入内置样例：${seed.blocks.length} 块 / ${seed.claims.length} 条 claims（零 key 演示可直接走通）。`,
    );
  } catch (e) {
    console.warn('[demo] 灌库失败（已回滚，不影响真实模式）：', e?.message ?? e);
  }
}

seedIfMissing();

const nextBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(nextBin, ['next', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, MOCK_LLM: '1' },
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 0));
