import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 评审席三态逻辑的契约测试。
 *
 * 【为什么能在 Node 里测 tsx 组件】
 * 组件是纯函数（不接流、不发请求、不用 useState），但 Node 直接 import .tsx 会因 JSX 语法失败。
 * 所以这里测的不是组件本身，而是**组件里那条唯一的状态判定规则**——
 * 把它抽成纯函数再看行为，这正是"三态"最容易出错的地方：
 *   - 当前者是 current（必须有下划线 + 呼吸点）
 *   - 问过的是 past（必须降透明度）
 *   - 没轮到的是 idle
 * 三者的判定若出现"既 current 又 past"，界面会同时显示下划线和灰暗，等于告诉用户"这位正在说话但已经走了"。
 */

/** 与 components/Bench.tsx 中的 seatStateOf 保持同一规则（改一处必须改两处，测试即契约） */
function seatStateOf(id: string, currentId: string | null, pastIds: string[]): 'current' | 'past' | 'idle' {
  if (id === currentId) return 'current';
  if (pastIds.includes(id)) return 'past';
  return 'idle';
}

test('seatStateOf：当前者优先于"已问过"（不会同时是 current 和 past）', () => {
  // 这是最关键的一条：若 past 判定先判，正在说话的评委会被降透明度，
  // 用户看到"这个人已经问完了"和"他现在正在说话"两个互相矛盾的信号叠在一起。
  const state = seatStateOf('p1', 'p1', ['p1']);
  assert.equal(state, 'current', '即使 p1 在 pastIds 里，当前者仍必须是 current');
});

test('seatStateOf：已问过且不是当前者 → past', () => {
  assert.equal(seatStateOf('p2', 'p1', ['p2']), 'past');
});

test('seatStateOf：没问过也没轮到 → idle', () => {
  assert.equal(seatStateOf('p3', 'p1', ['p1', 'p2']), 'idle');
});

test('seatStateOf：会话结束（currentId 为 null）→ 没有 current，问过的仍降透明度', () => {
  // 会话 ENDED 后 currentPersonaId 为 null。此时不该有任何座位被高亮，
  // 但"谁问过"的历史不能丢 —— 否则横条变成一排全新的座位，看起来像开了新一场。
  assert.equal(seatStateOf('p1', null, ['p1']), 'past');
  assert.equal(seatStateOf('p2', null, ['p1']), 'idle');
});

test('seatStateOf：空 pastIds → 只有一位 current，其余 idle（首次进入的样子）', () => {
  assert.equal(seatStateOf('p1', 'p1', []), 'current');
  assert.equal(seatStateOf('p2', 'p1', []), 'idle');
});

test('Bench.tsx：状态只有 current / past / idle 三个，出现别的就是自己加戏', () => {
  const src = fs.readFileSync('components/Bench.tsx', 'utf8');
  const declared = [...src.matchAll(/BenchSeatState = '[a-z]+' \| '[a-z]+' \| '[a-z]+'/g)];
  assert.equal(declared.length, 1, 'state 类型必须是三个字面量的联合');
  const states = (declared[0][0].match(/'([a-z]+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(states, ['current', 'past', 'idle']);
});

test('Bench.css：三态的视觉必须可分（current 有下划线、past 降透明度、idle 有呼吸点被压暗）', () => {
  // 这三条是"评审席"能成立的全部：没有下划线看不出谁在说话，
  // 没有降透明度看不出谁问过，呼吸点不动就只是装饰。
  const css = fs.readFileSync('components/Bench.css', 'utf8');
  assert.ok(css.includes('.seat.is-current::after'), 'current 必须有朱红下划线（::after 实现）');
  assert.ok(/\.seat\.is-past\s*\{[^}]*opacity/.test(css), 'past 必须降透明度');
  assert.ok(/\.seat\.is-past \.seat-pulse|\.seat\.is-idle \.seat-pulse/.test(css), 'past/idle 的呼吸点必须与 current 不同');
  assert.ok(css.includes('180ms'), '评委切换必须是 180ms（§3.2 动效 #3）');
});

test('Bench.css：不许出现十六进制颜色（铁律 9：颜色只走 token）', () => {
  const css = fs.readFileSync('components/Bench.css', 'utf8');
  // 去掉注释再查，避免注释里的说明文字误报
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hex = stripped.match(/#[0-9a-fA-F]{3,8}/g);
  assert.equal(hex, null, `组件样式里出现了硬编码颜色：${hex?.join(', ')}`);
});

test('Bench.css：字号只允许 5 级（11 / 13.5 / 17 / 34 / 62）', () => {
  const css = fs.readFileSync('components/Bench.css', 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sizes = [...stripped.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
  const allowed = new Set([11, 13.5, 17, 34, 62]);
  for (const s of sizes) {
    assert.ok(allowed.has(s), `出现了第 6 级字号 ${s}px —— 只允许 11 / 13.5 / 17 / 34 / 62`);
  }
});

test('Bench.css：不许有圆角（圆角只给输入框；本拍还没做输入框）', () => {
  const css = fs.readFileSync('components/Bench.css', 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(stripped.match(/border-radius/g), null, '评审席横条不该有任何圆角');
});
