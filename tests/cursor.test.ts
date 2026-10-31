import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 流式光标的规格测试 + 接流的几条硬约定。
 *
 * 用户明确指定的规格：
 *   「竖线块，1.05s steps(2,end) 明灭，收到 done 立刻消失」
 * 这三条各自都可能被"顺手改掉"，所以逐条钉死。
 */

const pagePath = 'app/session/[id]/page.tsx';
const cssPath = 'app/session/[id]/session.css';

test('光标样式：竖线块（2px 宽、1em 高），朱红 token 色', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = stripped.slice(stripped.indexOf('.cursor {'), stripped.indexOf('.cursor {') + 260);
  assert.ok(/width:\s*2px/.test(block), '光标必须是 2px 粗（竖线块，不是宽块）');
  assert.ok(/height:\s*1em/.test(block), '光标高度用 1em，随字号走');
  assert.ok(/background:\s*var\(--red\)/.test(block), '光标要用朱红 token，不能写死颜色');
  assert.ok(/display:\s*inline-block/.test(block), '必须是 inline-block 才能跟字走');
  assert.ok(/vertical-align/.test(block), '必须设 vertical-align，否则光标会浮起来');
});

test('光标动画：1.05s steps(2,end) 明灭（不是渐变、不是别的时长）', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 取出 @keyframes cursor-blink 块
  const kf = stripped.slice(stripped.indexOf('@keyframes cursor-blink'));
  assert.ok(kf.length > 0, '必须有 cursor-blink 关键帧');
  // 动画声明必须在 .cursor 上，且参数精确
  const decl = [...stripped.matchAll(/animation:\s*cursor-blink\s*([^;]+);/g)];
  assert.equal(decl.length, 1, '光标动画只许声明一次');
  const params = decl[0][1].replace(/\s+/g, ' ');
  assert.ok(params.includes('1.05s'), `时长必须是 1.05s，实际：${params}`);
  assert.ok(params.includes('steps(2'), `必须是 steps 离散跳，实际：${params}`);
  assert.ok(params.includes('infinite'), `必须无限循环，实际：${params}`);
});

test('光标：done 即消失（is-done 必须是 display:none，不是只停动画）', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = stripped.indexOf('.cursor.is-done');
  assert.ok(idx > 0, '必须有 .cursor.is-done 规则');
  const block = stripped.slice(idx, idx + 120);
  assert.ok(
    /display:\s*none/.test(block),
    'done 时必须 display:none —— 只停 animation 会留下一个常亮的方块，看起来像还在打字',
  );
});

test('动效账：本文件只新增 #1 光标闪烁，不该出现扫读光带 / 引用脉冲等其它动效', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const keyframes = [...stripped.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(keyframes, ['cursor-blink'], `本拍只许有 cursor-blink 一个关键帧，实际：${keyframes.join(', ')}`);
});

/** 剥掉注释后的源码（避免把"我不做 X"的说明性注释误判成"我做了 X"） */
function codeOf(path: string): string {
  return fs
    .readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('页面：必须用 addEventListener(具名事件)，不能用 onmessage', () => {
  // 【真实坑】服务端发的是 event: meta / token / done / error 具名事件，
  // es.onmessage 只收"没有 event 名"的默认消息，用它就一个事件都收不到，
  // 表现为"页面一直停在正在发言…，一个字都不出现"。
  const src = codeOf(pagePath);
  assert.ok(!/es\.onmessage/.test(src), '不许用 onmessage');
  for (const name of ['meta', 'token', 'done']) {
    assert.ok(
      new RegExp(`addEventListener\\('${name}'`).test(src),
      `必须监听 '${name}' 具名事件`,
    );
  }
});

test('页面：done / error 之后必须 close()，否则 EventSource 自动重连会无限刷', () => {
  const src = fs.readFileSync(pagePath, 'utf8');
  // done 分支里要有 close
  const doneBlock = src.slice(src.indexOf("addEventListener('done'"), src.indexOf("addEventListener('error'"));
  assert.ok(doneBlock.includes('es.close()'), 'done 分支必须 close()');
  // error 的具名分支里也要有
  const errBlock = src.slice(src.indexOf("addEventListener('error'"));
  assert.ok(errBlock.includes('es.close()'), '具名 error 分支必须 close()');
});

test('页面：用 finishedRef 拦掉 close() 自己触发的连接层 error', () => {
  // 【真实缺陷】es.close() 会让浏览器补发一个无 data 的连接层 error 事件。
  // 若只靠 setState 判断"是否已 done"，就会依赖一次渲染的时序，
  // 正常结束会被画成"中断"。必须用 ref 显式记录。
  const src = fs.readFileSync(pagePath, 'utf8');
  assert.ok(src.includes('finishedRef'), '必须有 finishedRef');
  assert.ok(
    /if\s*\(finishedRef\.current\)\s*return/.test(src),
    '连接层 error 分支必须先检查 finishedRef 再决定是否置为 error',
  );
  assert.ok(
    src.includes('finishedRef.current = false'),
    '每次开新流都要重置 finishedRef，否则复用组件时会沿用上一轮的收尾状态',
  );
});

test('页面：token 只做字符串拼接，不把 JSON 当文本显示', () => {
  // 服务端已经把 {"question": ...} 解包成纯人话，前端拿到 t 直接拼。
  // 若这里再 JSON.parse 一次整个 data 当文本，就会出现 {"t":"..."} 这样的显示。
  const src = fs.readFileSync(pagePath, 'utf8');
  const tokenBlock = src.slice(src.indexOf("addEventListener('token'"), src.indexOf("addEventListener('done'"));
  assert.ok(tokenBlock.includes('t?.t'), '必须只取 payload.t 字段');
  assert.ok(!tokenBlock.includes('innerHTML'), '绝不 innerHTML（S3）');
});

test('页面：不许出现 innerHTML / dangerouslySetInnerHTML（安全基线 S3）', () => {
  const src = fs.readFileSync(pagePath, 'utf8');
  assert.ok(!/dangerouslySetInnerHTML/.test(src), 'S3：模型输出一律纯文本渲染');
});

test('页面：输入框与暂存【已按后续指令加入】—— 这条旧的范围守卫已随需求反转', () => {
  // 【历史】上一拍用户明确说「只做流+光标（不含输入框、不含 localStorage）」，
  // 当时这条测试断言"不许有 textarea / localStorage"，用来防人顺手加东西。
  // 【现在】用户已明确要求做输入框与暂存（阶段 3 第 5 条），
  // 所以这条守卫必须**反转**：现在要求它们**存在**，而不是不许存在。
  // 留下的价值：它会提醒后来者——范围守卫是跟着指令走的，不是永久的禁令。
  const src = fs.readFileSync(pagePath, 'utf8');
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const codeOnly = noBlockComments
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(/<textarea/i.test(codeOnly), '本拍应已加入作答输入框');
  assert.ok(/localStorage/.test(codeOnly), '本拍应已加入答案暂存');
});
