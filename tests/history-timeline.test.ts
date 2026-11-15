import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 「已答记录」时间线的收录规则。
 *
 * 【为什么要钉这个】
 * 2026-11-15 录制前实测发现同一个问题在屏幕上出现两遍：上面「已答记录」里一条，
 * 下面问题卡里又一条。根因不是渲染重复，是**收录口径错了**——
 * 服务端 `turns` 是全部轮次，包含正在问、还没答的那一条（`answer` 为空串）；
 * 前端把它一起塞进了 `aria-label="已答记录"` 的时间线。
 *
 * 这条特别容易被"优化"回去：比如改成 `slice(0, -1)`（取最后一条以外），
 * 看着也能消掉重复，但只要出现"插了追问但还没答"、"降级提交"这类轮次组合，
 * 就会错位。判据必须是语义的——**时间线的语义是"我说过什么"，没说的话不占行**。
 */

const pagePath = 'app/session/[id]/page.tsx';

function codeOf(path: string): string {
  return fs
    .readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('已答记录：只收 answer 非空的轮次（服务端 history 要过滤）', () => {
  const src = codeOf(pagePath);
  // 服务端来的一条必须带 answer 非空判据
  const serverLine = src.match(/const serverHistory = .*;/);
  assert.ok(serverLine, '必须有 serverHistory');
  assert.match(
    serverLine![0],
    /filter\(\(h\) => \(h\.answer \?\? ''\)\.trim\(\) !== ''\)/,
    `serverHistory 必须按 answer 非空过滤，实际：${serverLine![0]}`,
  );
});

test('已答记录：合并后的 history 也要再过滤一次（本地乐观条目同规则）', () => {
  const src = codeOf(pagePath);
  const merged = src.match(/const history: HistoryItem\[\] = [\s\S]*?sort\(\(a, b\) => a\.seq - b\.seq\);/);
  assert.ok(merged, '必须有 history 合并表达式');
  assert.match(
    merged![0],
    /filter\(\(h\) => \(h\.answer \?\? ''\)\.trim\(\) !== ''\)/,
    '合并后必须再过一遍 answer 非空（本地乐观条目也可能 answer 为空）',
  );
});

test('已答记录：不许用 slice(0, -1) 之类的位置口径冒充"没答完"', () => {
  const src = codeOf(pagePath);
  // 位置口径在"追问未答"、"降级提交"这些组合下会错位；语义口径才稳
  assert.ok(
    !/serverHistory[^\n]*\.slice\(0,\s*-1\)/.test(src),
    '不许用 slice(0,-1) 排除未答轮次（应判 answer 是否为空）',
  );
});

test('已答记录：verdict 面板排他规则仍在（同一问答不许显示两处）', () => {
  const src = codeOf(pagePath);
  assert.ok(
    src.includes('.filter((h) => h.turnId !== verdictTurnId)'),
    '刚答完的那一问仍要按 verdictTurnId 排除，避免判分面板与时间线各渲染一遍',
  );
});
