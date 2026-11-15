import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 会话页的两个"留白"约束：已答记录默认折叠、作答区钉在视口底部。
 *
 * 【为什么钉这两条】
 * 2026-11-15 录制前 CDP 实测（视口 1440×900）：
 *   `.history` top=259 h=614  （只答过 2 轮就 614px）
 *   `.answer`  top=1190 h=233 → **在整屏之外**
 * 也就是"评委问完，我得滚一整屏才够得着作答框"。
 * 演示里这个动作会被镜头完整拍下来，等于把闭环切断了。
 *
 * 折叠要用 button 而不是加 onClick 的 div：
 * 键盘 Tab 能到、回车能展开，否则这个能力变成鼠标专属。
 */

function codeOf(path: string): string {
  return fs
    .readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const pageSrc = codeOf('app/session/[id]/page.tsx');
const css = fs.readFileSync('app/session/[id]/ask.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('折叠：默认全折叠，「展开」是按条累加的额外状态', () => {
  assert.match(pageSrc, /const \[openTurns, setOpenTurns\] = useState<Set<string>>\(new Set\(\)\)/, 'openTurns 初值必须是空集合（＝默认折叠）');
  assert.match(pageSrc, /const \[expandHistory, setExpandHistory\] = useState\(false\)/, 'expandHistory 初值必须是 false');
  assert.match(
    pageSrc,
    /const open = expandHistory \|\| openTurns\.has\(h\.turnId\)/,
    '展开 = 全部展开 或 这一条被单独点开',
  );
});

test('折叠：折叠头是可聚焦的 button 且带 aria-expanded', () => {
  assert.match(pageSrc, /className="hist-row"[\s\S]{0,200}?type="button"/, '折叠头必须是 type="button"');
  assert.match(pageSrc, /aria-expanded=\{open\}/, '折叠头必须带 aria-expanded，读屏能播报展开态');
});

test('折叠：只有展开时才渲染问答正文（折叠态不许留 DOM）', () => {
  // 折叠态只该有一行；若正文还在 DOM 里，折叠就不省高度了
  assert.match(
    pageSrc,
    /\{open \? \(\s*<div className="hist-body">/,
    'hist-body 必须挂在 open 条件里',
  );
});

test('折叠：CSS 里 .hist-item 不再有固定上下 padding（否则折叠也不省纵向空间）', () => {
  const block = css.match(/\.hist-item \{[^}]*\}/);
  assert.ok(block, '必须有 .hist-item');
  assert.match(block![0], /padding:\s*0;/, `折叠态 .hist-item 应为 padding: 0，实际：${block![0]}`);
});

test('折叠：.hist-row 是整行可点的按钮（width 100% + cursor pointer）', () => {
  const block = css.match(/\.hist-row \{[^}]*\}/);
  assert.ok(block, '必须有 .hist-row');
  assert.match(block![0], /width:\s*100%/, '.hist-row 必须占满整行');
  assert.match(block![0], /cursor:\s*pointer/, '.hist-row 必须显示可点');
  assert.match(block![0], /border:\s*0/, 'button 默认边框必须清掉');
});

test('作答区：sticky 钉底，而不是 fixed 脱离文档流', () => {
  const block = css.match(/\.answer \{[^}]*\}/);
  assert.ok(block, '必须有 .answer');
  assert.match(block![0], /position:\s*sticky/, '.answer 必须 position: sticky');
  assert.match(block![0], /bottom:\s*12px/, '.answer 必须贴底并留 12px 呼吸位');
  assert.ok(
    !/position:\s*fixed/.test(block![0]),
    '.answer 不许用 fixed —— 会脱离流、永久盖住正文底部',
  );
});

test('作答区：新增样式没有引入动效也没引入第二个圆角', () => {
  const radius = css.match(/border-radius:/g) ?? [];
  assert.equal(radius.length, 1, `ask.css 里 border-radius 只许一处（.answer-input 的 6px），实际 ${radius.length} 处`);
  assert.ok(!/\.hist-row[^{]*\{[^}]*animation:/.test(css), '折叠头不许带动效');
  assert.ok(!/\.answer \{[^}]*animation:/.test(css), '作答区不许带动效');
});
