import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * mock 回放序号必须从库里推导，不能只靠进程内游标。
 *
 * 【为什么钉这条】
 * 2026-11-15 录制前真踩过：第 1 问答完后我改代码重启了 dev server，
 * 再答第 2 问时，屏幕上是「许教授」的席位，问的却是陈评委那句评测集问题
 * —— 因为 `lib/llm.ts` 的回放游标挂在 globalThis 上，重启即归零，
 * 第 2 问又去取了 `question.json` 的第 0 条。
 *
 * 序号是**库里已经有的事实**（本场问过几问、我答过几次），
 * 再拿一份内存游标当权威，就等于多了一个会漂移的副本。
 * 这三条断言钉的就是"调用方必须把库里的序号传下去"。
 */

function codeOf(path: string): string {
  return fs
    .readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const llmSrc = codeOf('lib/llm.ts');
const streamSrc = codeOf('app/api/sessions/[id]/stream/route.ts');
const answerSrc = codeOf('app/api/sessions/[id]/answer/route.ts');

test('llm.ts：CallInput 必须声明 replaySeq 字段', () => {
  assert.match(
    llmSrc,
    /replaySeq\?:\s*number;/,
    'CallInput 必须带 replaySeq —— 否则调用方传了也被类型丢掉',
  );
});

test('llm.ts：两条回放路径都走 takeSeq（callMock 与 streamBody 不许各写一套游标）', () => {
  const uses = llmSrc.match(/const seq = takeSeq\(input\);/g) ?? [];
  assert.equal(
    uses.length,
    2,
    `callMock 与 streamBody 都要用 takeSeq，实际出现 ${uses.length} 次`,
  );
});

test('llm.ts：takeSeq 给了 replaySeq 就以它为权威，并把游标对齐到它之后', () => {
  assert.match(llmSrc, /function takeSeq\(input: CallInput\): number/, '必须有 takeSeq');
  assert.match(
    llmSrc,
    /typeof input\.replaySeq === 'number'/,
    'takeSeq 必须识别 replaySeq',
  );
  assert.match(
    llmSrc,
    /mockCursor\.set\([^)]*forced \+ 1\)|mockCursor\.set\(`\$\{input\.sessionKey\}:\$\{input\.phase\}`, forced \+ 1\)/s,
    '给了 replaySeq 后要把游标对齐到 forced + 1，避免同一进程里后续不传 replaySeq 的调用回头重播',
  );
});

test('stream 路由：question 的 replaySeq 由「本场第几问」推导（round - 1）', () => {
  assert.match(
    streamSrc,
    /replaySeq:\s*round - 1,/,
    'stream 必须在 callLLMStream 里传 replaySeq: round - 1',
  );
  // round 的来源必须是库里的主问条数，不能是内存计数
  assert.match(
    streamSrc,
    /mainsDoneOf\(loadTurns\(session\.id\)\) \+ 1/,
    'round 必须由 mainsDoneOf(loadTurns(...)) 推导',
  );
});

test('answer 路由：evaluate 的 replaySeq 由「已答过几次」推导（不含当前这一问）', () => {
  assert.match(
    answerSrc,
    /replaySeq:\s*turnsBefore\.filter\(\(t\) => String\(t\.answer \?\? ''\) !== ''\)\.length,/,
    'answer 必须传「turnsBefore 里 answer 非空的条数」—— 当前这一问此时 answer 还是空的',
  );
});
