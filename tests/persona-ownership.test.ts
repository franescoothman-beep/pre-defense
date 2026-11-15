import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 人设行的生命周期：**一场的人设跟着那一场活多久，就活多久**。
 *
 * 【为什么钉这条】
 * 旧版本建新会话时执行 `delete from personas where doc_id = ?`，
 * 把这份材料**所有历史人设**整批删掉。后果：
 *   旧会话 turns.persona_id 全部变悬空外键 → 报告页审议轨迹统一显示「评委」。
 *   2026-11-15 实测踩中：session 539746c6 的 seq1/seq2 署名丢失。
 *
 * 现在人设写入必带 session_id，loadPersonas 第一级按 session_id 取，
 * 多场并存互不污染——整批删除的前提已经不存在。唯一要清的是
 * 迁移前的遗留行（session_id is null）：它们不属于任何一场，
 * 留着只会让第②级兜底捞到错误批次。
 */

function codeOf(path: string): string {
  return fs
    .readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const createSrc = codeOf('app/api/sessions/route.ts');

test('建会话：不许整批删除这份材料的历史人设', () => {
  assert.ok(
    !/delete from personas where doc_id = \?`,\s*docId\)/.test(createSrc),
    'delete from personas where doc_id = ? 会把旧会话的人设一起删掉（悬空外键）',
  );
});

test('建会话：只清没有挂会话的遗留行（session_id is null）', () => {
  assert.match(
    createSrc,
    /delete from personas where doc_id = \? and session_id is null/,
    '遗留行（无 session_id）才允许清；带 session_id 的人设属于那一场，必须保留',
  );
});

test('读侧：personaOfTurn 必须存在，且 direct 命中优先于回推', () => {
  const src = codeOf('lib/session.ts');
  assert.match(src, /export function personaOfTurn\(/, 'lib/session.ts 必须导出 personaOfTurn');
  // 先精确匹配 persona_id，miss 才回推 —— 顺序反了就会在能精确命中时也去回推
  const body = src.match(/export function personaOfTurn\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(body, 'personaOfTurn 函数体必须能取到');
  const directIdx = body.indexOf("p.id === turn.personaId");
  const fallbackIdx = body.indexOf('personaIndexOfMain(mainIndex');
  assert.ok(directIdx > -1, '必须先按 persona_id 精确匹配');
  assert.ok(fallbackIdx > -1, 'miss 后必须按席位轮转规则回推');
  assert.ok(directIdx < fallbackIdx, '精确匹配必须在回推之前');
});

test('读侧：回推不许出现在「没有任何主问」的 turn 上（不编席位）', () => {
  const src = codeOf('lib/session.ts');
  assert.match(
    src,
    /if \(mainIndex < 0\) \{[\s\S]*?return null;/,
    '这条 turn 之前没有任何主问时必须返回 null，而不是硬凑第 0 位',
  );
});

test('消费方：不许再有 `personas.find(...) ?? personas[0]` 的静默兜底', () => {
  const files = [
    'app/api/sessions/[id]/answer/route.ts',
    'app/api/sessions/[id]/next/route.ts',
    'app/api/sessions/[id]/stream/route.ts',
  ];
  for (const f of files) {
    const src = codeOf(f);
    assert.ok(
      !/personas\.find\([^)]*\)\s*\?\?\s*personas\[0\]/.test(src),
      `${f} 里还有静默退第 0 位的写法 —— 人设悬空时会错着走下去而不报错`,
    );
  }
});

test('读侧消费方：报告轨迹 / 会话历史 / end 路由都走 personaOfTurn', () => {
  assert.match(
    codeOf('app/api/reports/[id]/route.ts'),
    /personaOfTurn\(t, turns, personas,/,
    '报告审议轨迹必须走 personaOfTurn（旧会话署名不能丢）',
  );
  assert.match(
    codeOf('app/api/sessions/[id]/route.ts'),
    /toHistoryItem\(t, personas, turns,/,
    '会话历史必须走 personaOfTurn',
  );
  const endSrc = codeOf('app/api/sessions/[id]/end/route.ts');
  assert.match(endSrc, /personaOfTurn\(t, turns, personas,/, 'askedDims 必须走 personaOfTurn');
  assert.match(endSrc, /personaOfTurn\(t, turns, personas, matrix\.mainsEach\)\?\.name/, 'turnsForModel 必须走 personaOfTurn');
});
