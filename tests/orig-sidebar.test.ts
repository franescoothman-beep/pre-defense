import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 右侧原文栏「可交互」的规格测试。
 *
 * 【为什么要钉这个】
 * 2026-11-15 侧栏第一版是**只读**的：点某一段不定位，也没有回程入口。
 * 录制时评委会问"这能点吗"——点了没反应比明确不能点更糟。
 * 补交互之后，有三件事特别容易被后续改动顺手做坏：
 *   ① 用户翻页把"评委正在读"的块也改了（等于篡改了现场事实）
 *   ② 给 absence 也挂 onClick（它证明"原文里没有这句"，没有可跳的目标）
 *   ③ 回程按钮常驻（没翻的时候它无处可回，出现就是误导）
 * 这些都是"看起来更统一、其实更假"的简化，所以逐条钉死。
 */

const pagePath = 'app/session/[id]/page.tsx';
const askPath = 'app/session/[id]/ask.css';

/** 剥掉注释后的源码（避免把"我不做 X"的说明误判成"我做了 X"） */
function codeOf(path: string): string {
  return fs
    .readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('侧栏：翻页与"评委在读"是两个状态，不许共用一个变量', () => {
  const src = codeOf(pagePath);
  assert.ok(src.includes('peekIdx'), '必须有 peekIdx：用户手翻到的那一段');
  assert.ok(src.includes('currentBlockIdx'), '必须有 currentBlockIdx：评委此刻在读的那一段');
  // 实际的显示位置由两者合成，缺一不可
  assert.match(
    src,
    /const viewIdx = peekIdx \?\? currentBlockIdx/,
    'viewIdx 必须是「用户翻的优先，否则跟随评委」',
  );
});

test('侧栏：评委换块时必须收回用户的翻页（否则看起来像坏了）', () => {
  const src = codeOf(pagePath);
  // 单独一个 effect 监听 currentBlockIdx 并清空 peekIdx
  const hit = src.match(/useEffect\(\(\) => \{\s*setPeekIdx\(null\);\s*\}, \[currentBlockIdx\]\)/);
  assert.ok(hit, '必须有「currentBlockIdx 变化 → setPeekIdx(null)」的 effect');
});

test('侧栏：点段定位走 data-idx 查，不依赖单个 ref', () => {
  const src = codeOf(pagePath);
  // 焦点既可能是评委的块、也可能是用户点的块，ref 只能挂一个
  assert.ok(src.includes('data-idx={b.idx}'), '每段必须带 data-idx');
  assert.ok(
    src.includes('querySelector<HTMLElement>(`[data-idx="${viewIdx}"]`)'),
    '滚动居中必须按 viewIdx 查 DOM，而不是用 ref 猜',
  );
});

test('侧栏：每一段是 button（键盘可到、读屏可念），不是 div + onClick', () => {
  const src = codeOf(pagePath);
  const idx = src.indexOf('className={`orig-block');
  assert.ok(idx > 0, '必须有 .orig-block');
  // 往前找最近的标签开
  const open = src.lastIndexOf('<', idx);
  assert.equal(src.slice(open, open + 7), '<button', '原文块必须是 <button>（可聚焦、可回车触发）');
  assert.ok(src.slice(open, idx).includes('type="button"'), '按钮必须写明 type="button"，避免被当作表单提交');
});

test('侧栏：absence 不许做成可点（它没有可跳的目标）', () => {
  const src = codeOf(pagePath);
  // 两处出处条（history 与 verdict）都必须按 kind 分流
  const jumps = [...src.matchAll(/locator-jump/g)];
  assert.ok(jumps.length >= 2, `出处条的可点类必须同时用在 history 与判分面板，实际 ${jumps.length} 处`);
  const absences = [...src.matchAll(/缺失 · 查过/g)];
  assert.ok(absences.length >= 2, 'absence 的文案两处都要在');
  // 关键：每一处 absence 分支都是 <span>，不带 onClick
  for (const m of src.matchAll(/缺失 · 查过/g)) {
    const before = src.slice(Math.max(0, m.index! - 600), m.index!);
    const lastSpan = before.lastIndexOf('<span');
    const lastButton = before.lastIndexOf('<button');
    assert.ok(lastSpan > lastButton, 'absence 必须渲染成 <span>（不可点），不能被套进 <button>');
  }
});

test('侧栏：回程按钮只在对不上时出现', () => {
  const src = codeOf(pagePath);
  const idx = src.indexOf('className="orig-back"');
  assert.ok(idx > 0, '必须有回程按钮 .orig-back');
  // 它的渲染条件必须是 isPeeking
  const before = src.slice(Math.max(0, idx - 220), idx);
  assert.ok(before.includes('isPeeking ?'), '回程按钮必须挂在 isPeeking 条件下，不能常驻');
  // isPeeking 的定义：翻到了别处
  assert.match(
    src,
    /const isPeeking = peekIdx !== null && peekIdx !== currentBlockIdx/,
    'isPeeking 必须是「翻到了别处」，不是「翻过」',
  );
});

test('侧栏：页面写"查看"还是"当前"必须如实分叉', () => {
  const src = codeOf(pagePath);
  assert.ok(src.includes('查看 BLOCK {viewIdx}'), '翻到别处时页头必须写「查看 BLOCK n」');
  assert.ok(src.includes('当前 BLOCK {currentBlockIdx}'), '跟随时页头必须写「当前 BLOCK n」');
});

test('侧栏：命中高亮只在「评委正在读的那一块」里标', () => {
  const src = codeOf(pagePath);
  // 翻到别处时整篇到处亮同一句话，会让人分不清哪一句是这一问的依据
  const idx = src.indexOf('splitByQuote(b.text, anchorQuote(meta, b.text))');
  assert.ok(idx > 0, '必须用 splitByQuote 切命中句');
  const before = src.slice(Math.max(0, idx - 200), idx);
  assert.ok(before.includes('isNow &&'), '切命中句的前提必须是 isNow（当前块），不能是 isView');
});

test('侧栏：尺寸约束不许被顺手改掉', () => {
  const css = codeOf(askPath);
  // 62vh：比一屏短一截，保证问题卡与作答框仍在视野里
  const body = css.slice(css.indexOf('.orig-body {'), css.indexOf('.orig-empty {'));
  assert.ok(body.includes('max-height: 62vh'), '滚动容器必须锁 62vh');
  assert.ok(body.includes('overflow-y: auto'), '滚动容器必须能滚');
  // 圆角仍然只有 .answer-input 一处（在 scan.test.ts 里已有全局断言，这里补一条针对侧栏的）
  const orig = css.slice(css.indexOf('.orig {'));
  assert.ok(!orig.includes('border-radius'), '侧栏不许引入圆角（全站圆角只留给输入框）');
  // 侧栏不许新增动效
  assert.ok(!/animation\s*:/.test(orig), '侧栏不许有 animation（动效账已封顶两处）');
});
