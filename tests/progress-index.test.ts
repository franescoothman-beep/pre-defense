// lib/session.ts 的 progressOf 口径：qIndex 数「答完的主问」，不数「已发出的主问」
//
// 【这条测试的来历】2026-11-15 录制段② 时，从抽帧里看到第 1 问刚播出、还没人回答，
// 顶部就写着「第 2 / 3 问 · 席位 2 / 3」。接口复现：
//   新建会话      → qIndex:1, mains:0  ✔
//   发出第一问后  → qIndex:2, mains:1  ✘（题面还是第 1 问）
// 根因是 progressOf 用 mainsDoneOf 计数，它把"已发出但未作答"的那条 turn 也算作已问完。
// 而 mainsDoneOf 在其它地方（收口判定、席位轮转）**必须**这么算，所以不能直接改它，
// 只能在 progressOf 里单独数"答完的"。
//
// 测试用源码断言而不是跑 DB：progressOf 要 loadTurns/loadPersonas，单测里没有库。
// 源码断言在这里是合适的——它守的正是"这两个计数必须分开"这个决定本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(process.cwd(), 'lib', 'session.ts'), 'utf8');

function progressOfBody() {
  const start = SRC.indexOf('export function progressOf(');
  assert.ok(start > 0, '找不到 progressOf');
  // 截到下一个顶层 export 为止
  const next = SRC.indexOf('\nexport ', start + 10);
  return SRC.slice(start, next > 0 ? next : SRC.length);
}

test('progressOf：qIndex 必须数"答完的主问"，不许直接用 mainsDoneOf 的结果加一', () => {
  const body = progressOfBody();

  assert.match(
    body,
    /mainsAnswered/,
    '必须有一个"答完的主问数"的独立变量（mainsAnswered），不能拿 mains 直接算 qIndex',
  );
  assert.match(
    body,
    /t\.kind === 'question' && t\.answer !== null && t\.answer !== ''/,
    'mainsAnswered 的判据必须是"kind=question 且 answer 非空"',
  );
  assert.match(
    body,
    /qIndex:\s*Math\.min\(mainsAnswered \+ 1/,
    'qIndex 必须由 mainsAnswered 推出（第 1 问答完前应停在 1）',
  );
  assert.doesNotMatch(
    body,
    /qIndex:\s*Math\.min\(mains \+ 1/,
    'qIndex 不许再用 mains + 1 —— 那会把"刚发出的一问"算成已完成（第 1 问显示成第 2 问）',
  );
});

test('progressOf：席位高亮必须跟着"正在答的那一问"，不许用已回答数越界', () => {
  const body = progressOfBody();
  assert.match(body, /currentMainIndex/, '必须有 currentMainIndex');
  assert.match(
    body,
    /personaIndexOfMain\(currentMainIndex/,
    'personaIndex 必须由 currentMainIndex 推，否则第 1 问会点亮第 2 位评委',
  );
  assert.match(
    body,
    /Math\.min\(mainsAnswered,\s*Math\.max\(0,\s*qTotal - 1\)\)/,
    'currentMainIndex 要夹在 [0, qTotal-1]，最后一问不许越界',
  );
});

test('progressOf：mains 仍要保留（收口与席位轮转靠它），两个计数不许合并成一个', () => {
  const body = progressOfBody();
  assert.match(body, /const mains = mainsDoneOf\(turns\)/, 'mains 仍要算（它等于"含未作答在内的已问数"）');
  assert.match(body, /mains,/, '返回值里仍要有 mains 字段（前端与测试在用）');
  assert.match(body, /answered,/, '返回值里仍要有 answered 字段');
});
