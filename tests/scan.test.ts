import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * L5 扫读原文思考态 + 作答暂存的规格测试。
 *
 * DoD 原文：「扫读原文」显示真实 block 文本 + 进度数字。
 * 这两条都可能被"顺手简化"（比如退化成一句"思考中"），所以钉死。
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

test('L5：光带必须是 2.6s linear（§3.2 动效 #2 的精确参数）', () => {
  const css = codeOf(askPath);
  const decl = [...css.matchAll(/animation:\s*scan-sweep\s*([^;]+);/g)];
  assert.equal(decl.length, 1, '光带动画只许声明一次');
  const p = decl[0][1].replace(/\s+/g, ' ');
  assert.ok(p.includes('2.6s'), `时长必须 2.6s，实际：${p}`);
  assert.ok(p.includes('linear'), `时序必须 linear（匀速扫读），实际：${p}`);
});

test('L5：光带用 background-position 扫，不改布局', () => {
  // translateY 一个绝对定位块会盖在文本上，还要处理层叠；
  // background-position 只影响背景、完全不触发重排，是更稳的做法。
  const css = codeOf(askPath);
  const kf = css.slice(css.indexOf('@keyframes scan-sweep'));
  assert.ok(/background-position/.test(kf), '关键帧里必须是 background-position');
  assert.ok(!/translateY/.test(kf), '不该用 translateY 位移');
});

test('L5：扫读结束后光带必须停，但要先把当前这一遍扫完', () => {
  // 【真实缺陷修复】光带一个周期 2.6s，而实测出字窗口只有约 1.0s。
  // done 时若立刻 animation:none，用户只能看到光带扫到 40% 就被掐断，「扫读」根本没完成。
  // 所以 is-settled 只把 iterations 收到 1（CSS 会把当前这一遍跑完），
  // 再由 is-swept（animationend / 超时兜底）真正移除。
  const css = codeOf(askPath);
  assert.ok(css.includes('.scan.is-settled'), '必须有"已结算"态');
  const settled = css.slice(css.indexOf('.scan.is-settled'), css.indexOf('.scan.is-swept'));
  assert.ok(
    /animation-iteration-count:\s*1/.test(settled),
    'is-settled 应把迭代数收到 1（扫完这一遍），而不是立刻 none',
  );
  assert.ok(
    !/animation:\s*none/.test(settled),
    'is-settled 里不许出现 animation:none —— 那会掐断扫到一半的光带',
  );

  const swept = css.slice(css.indexOf('.scan.is-swept'));
  assert.ok(/animation:\s*none/.test(swept), 'is-swept 才是真正移除光带的地方');
});

test('L5：光带的收尾必须有 animationend + 超时兜底两条路', () => {
  // 只靠 animationend 有风险：系统开"减少动效"、或某些浏览器在 background-position 上
  // 不触发 animationend，光带会永远扫下去，看起来像"还在思考"。
  const src = codeOf(pagePath);
  assert.ok(src.includes('onAnimationEnd'), '必须监听 animationend');
  assert.ok(/setTimeout\([^,]*,\s*3200\)/.test(src), '必须有 3.2s 超时兜底（2.6s 周期 + 余量）');
  assert.ok(src.includes('is-swept'), '必须打上 is-swept 才真正移除光带');
});

test('L5：页面必须显示真实 block 原文 + 三个进度数字', () => {
  const src = codeOf(pagePath);
  // 真实原文来自 meta.source
  assert.ok(src.includes('meta.source'), '必须渲染 meta.source（真实 block 文本）');
  // 三个进度数字
  assert.ok(src.includes('blockIdx'), '必须显示 BLOCK 编号');
  assert.ok(src.includes('blockTotal'), '必须显示块总数（BLOCK n/N 的 N）');
  assert.ok(src.includes('candidateTotal'), '必须显示"已检索 N 处候选引用"');
});

test('L5：不能退化成一句"思考中"（不许只有文案没有原文）', () => {
  const src = codeOf(pagePath);
  const scanIdx = src.indexOf('aria-label="评委正在读的原文"');
  assert.ok(scanIdx > 0, '扫读面板必须存在且自述用途');
  // 【按结构边界切片，不用固定字数】
  // 曾经用 `slice(scanIdx, scanIdx + 900)`，结果一改渲染逻辑(本步文案加了分支)，
  // .scan-text 就被挤出 900 字窗口，测试误报。固定长度切片对源码不敏感，是脆弱的做法。
  // 改成切到该 section 的闭合（下一个 `</section>`），与源码长度无关。
  const end = src.indexOf('</section>', scanIdx);
  assert.ok(end > scanIdx, '必须能定位到 section 结束');
  const block = src.slice(scanIdx, end);
  assert.ok(block.includes('scan-text'), '扫读面板里必须有承载原文的 .scan-text');
  assert.ok(block.includes('meta.source'), '扫读面板必须渲染 meta.source（真实 block 原文）');
});

test('输入框：是全站唯一允许圆角的地方，且必须正好 6px', () => {
  const css = codeOf(askPath);
  const allRadius = [...css.matchAll(/border-radius:\s*([^;]+)/g)];
  assert.equal(allRadius.length, 1, `本文件只许有 1 处圆角，实际 ${allRadius.length} 处`);
  assert.equal(allRadius[0][1].trim(), '6px', `圆角必须是 6px，实际 ${allRadius[0][1]}`);
  // 且这一处必须落在输入框规则里
  const inputBlock = css.slice(css.indexOf('.answer-input {'), css.indexOf('.answer-input:focus'));
  assert.ok(inputBlock.includes('border-radius: 6px'), '圆角必须属于 .answer-input');
});

test('输入框：提交按钮保持禁用（不做假提交骗人）', () => {
  const src = codeOf(pagePath);
  const idx = src.indexOf('answer-submit');
  assert.ok(idx > 0, '必须有提交按钮');
  const block = src.slice(idx, idx + 260);
  assert.ok(block.includes('disabled'), '阶段 4 才有判分接口，这里必须禁用');
  assert.ok(block.includes('阶段 4'), '必须写明为什么禁用，别让人以为是坏的');
});

test('暂存：草稿按「本场 + 本问」分键，不能只用 sessionId', () => {
  // 只按 sessionId 存一个串，第 2 问会覆盖第 1 问的草稿。
  const src = codeOf(pagePath);
  assert.ok(src.includes('draftKey'), '必须有 draftKey');
  const decl = src.match(/draftKey = .*`rehearsal:draft:\$\{[^}]+\}:\$\{[^}]+\}`/);
  assert.ok(decl, `draftKey 必须含 sessionId 与 turnId 两段，实际：${src.match(/draftKey = .*;/)}`);
});

test('暂存：读写都必须 try/catch（隐私模式下 localStorage 会抛）', () => {
  const src = codeOf(pagePath);
  const setIdx = src.indexOf('localStorage.setItem');
  const getIdx = src.indexOf('localStorage.getItem');
  assert.ok(setIdx > 0 && getIdx > 0, '必须有读有写');
  // 两处都必须在 try 里：向上找最近的 try
  const before = (i: number) => src.slice(Math.max(0, i - 200), i);
  assert.ok(before(setIdx).includes('try'), 'setItem 必须在 try 内');
  assert.ok(before(getIdx).includes('try'), 'getItem 必须在 try 内');
});

test('暂存：空内容要 removeItem，不要把空串写进去', () => {
  const src = codeOf(pagePath);
  assert.ok(src.includes('localStorage.removeItem'), '空草稿应删除键，而不是存一个空串');
});

test('动效账：本拍新增 #2 扫读光带，全站至此 3 处，不许有第 4 处', () => {
  // 4 处清单：① 光标闪烁 ③ 评委切换 180ms ② 扫读光带 ④ 引用脉冲（阶段 5）
  const cursorCss = codeOf('app/session/[id]/session.css');
  const benchCss = codeOf('components/Bench.css');
  const askCss = codeOf(askPath);
  const all = cursorCss + benchCss + askCss;

  const keyframes = [...all.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    keyframes.sort(),
    ['cursor-blink', 'scan-sweep'].sort(),
    `关键帧只许 cursor-blink 与 scan-sweep 两个，实际：${keyframes.join(', ')}`,
  );

  // 评审席只有 180ms transition，没有 animation
  assert.equal(benchCss.match(/animation\s*:/g), null, '评审席不许有 animation');
});
