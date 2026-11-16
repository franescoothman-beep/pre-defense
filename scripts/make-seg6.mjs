// scripts/make-seg6.mjs —— 段⑥ 评测数字（7:30–8:00）直接生成
//
// 【为什么这段也不录屏】与段① 同理：一张静态表逐行点亮，没有页面可点。
// 行的点亮时刻就是旁白的对位点，写在脚本里即确定，重跑即可微调。
//
// 【数字红线】表里每个数字都来自《录制全案.md §2》口径表，样本量必须与数字同屏：
//   引用命中 100% (11/11)、双采样 100% (3/3)、三份真实材料 79/91 = 86.8%
//   单测 464 全绿、fixture 51 项 0 失败
// 诚实声明「不是命中率已经稳定」必须压轴出现（progress.md 明确要求别临场想）。
// 注意：评测八项（11/11、3/3）是 11-02 真实 key 跑「旧样例」的结果 —— 台词用
// 「三份真实材料」而不是「当前样例」，口径已在录制全案 §2 标注。
//
// 配色出处 app/globals.css：--ink #17150f / --red #b03a2e / --bg #efeade /
// --muted #8a806d / --line-2 #d6cdbb（与段① 同底，剪在一起不跳色）。
//
// 用法：node scripts/make-seg6.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.join('docs', 'recordings');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'rehearsal-seg6-1080p.mp4');

// ── 配色（出处：app/globals.css :root）──
const INK = '0x17150f';
const RED = '0xb03a2e';
const PAPER = '0xefeade';
const MUTED = '0x8a806d';
const LINE2 = '0xd6cdbb';
const GREEN = '0x3d5f50'; // --green，用于「0 失败」这类"好"结果，与风险色区分

const W = 1920;
const H = 1080;
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';
const FONT_BD = 'C\\:/Windows/Fonts/msyhbd.ttc';

/** 与段① 同款的逐行淡入 drawtext */
function drawtext({ text, font = FONT, size, color, t0, dur = 1.2, x, y }) {
  const a = `if(lt(t,${t0}),0,if(lt(t,${t0 + dur}),(t-${t0})/${dur},1))`;
  // 【转义，全是实测踩出来的】
  //   `:` 会被当成 key=value 分隔符 → "No option name near 'fixtures:...'"
  //   `%` 走 drawtext 的 text 展开器 → "Stray % near ''"，而且 `\%` 在这里**不管用**。
  // 所以双管齐下：`:` 手工转义，`%` 用 expansion=none 连展开器一起关掉
  // （这些文案里没有任何 %{...} 展开需求，关掉是正确语义，不是绕过）。
  const safe = text.replace(/:/g, '\\:');
  return [
    `drawtext=fontfile='${font}'`,
    `text='${safe.replace(/'/g, "\\'")}'`,
    `expansion=none`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `alpha='${a}'`,
    x ? `x=${x}` : `x=(w-text_w)/2`,
    `y=${y}`,
  ].join(':');
}

/** 行分隔线（随行点亮） */
function rule(y, t0) {
  return `drawbox=x=420:y=${y}:w=1080:h=2:color=${LINE2}@0.9:t=fill:enable='gte(t,${t0})'`;
}

// ── 版式 ──
// 标题 y=120；表头 y=250；数据行 y=330 起每行 108px；声明 y=790；出处 y=960
const TITLE = '评测数字 · 全部可复现';
const COL1 = 420;  // 指标
const COL2 = 1180; // 数字
const COL3 = 1440; // 样本量

const rows = [
  { metric: '引用命中（评测材料）', value: '100%', sample: '11 / 11 条', t0: 2.0 },
  { metric: '双采样一致', value: '100%', sample: '3 / 3 组', t0: 6.5 },
  { metric: '三份真实材料 · quote 命中', value: '86.8%', sample: '79 / 91 条', t0: 11.0 },
  { metric: '单测', value: '464 全绿', sample: '464 条用例', t0: 17.0 },
  { metric: 'fixture 校验', value: '0 失败', sample: '51 项', t0: 20.5 },
];

// 行距 96（不是 108）：5 行 + 表头 + 两行诚实声明 + 出处小字要挤进 1080，
// 108 会把第 5 行推到 y≈776，和压轴声明（y=800）叠在一起（抽帧实测）。
const ROW_H = 96;
const ROW0 = 318;

const header = [
  drawtext({ text: '指标', size: 32, color: MUTED, t0: 1.2, dur: 0.8, x: COL1, y: 250 }),
  drawtext({ text: '数字', size: 32, color: MUTED, t0: 1.2, dur: 0.8, x: COL2, y: 250 }),
  drawtext({ text: '样本量', size: 32, color: MUTED, t0: 1.2, dur: 0.8, x: COL3, y: 250 }),
];

const rowParts = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const y = ROW0 + i * ROW_H;
  const isLastGood = r.value === '0 失败';
  rowParts.push(
    drawtext({ text: r.metric, size: 40, color: INK, t0: r.t0, x: COL1, y: y + 24 }),
    drawtext({
      text: r.value, font: FONT_BD, size: 44,
      color: r.value === '86.8%' ? RED : isLastGood ? GREEN : INK,
      t0: r.t0, x: COL2, y: y + 18,
    }),
    drawtext({ text: r.sample, size: 34, color: MUTED, t0: r.t0, x: COL3, y: y + 28 }),
    rule(y + 84, r.t0),
  );
}

// 86.8% 那行追加「不是 100%」小字（旁白同款口径，必须同屏）
// 位置放在该行「数字」列的正下方，不能用 COL2+260 —— 那里正好压在「79 / 91 条」上。
const note868 = drawtext({
  text: '不是 100%', font: FONT, size: 26, color: RED,
  t0: 12.2, dur: 0.8, x: COL2, y: ROW0 + 2 * ROW_H + 64,
});

// 诚实声明（压轴，朱红加粗）—— 一字不许改
const HONEST = '这些数字证明的是管道和机检在生效 —— 不是命中率已经稳定';
// 按破折号断行，不要按字数切：slice(0,18) 正好落在第一个「—」后面，
// 屏幕上会变成「…在生效 —」+「— 不是…」两个破折号（抽帧实测）。
const HONEST_CUT = HONEST.indexOf('——');
const honestParts = [
  drawtext({ text: HONEST.slice(0, HONEST_CUT).trim(), font: FONT_BD, size: 40, color: RED, t0: 23.5, dur: 1.4, y: 820 }),
  drawtext({ text: HONEST.slice(HONEST_CUT), font: FONT_BD, size: 40, color: RED, t0: 23.5, dur: 1.4, y: 878 }),
];

// 出处小字（评委能追到数字从哪来 —— 与产品主张同构）
// 冒号与百分号的转义已统一收进 drawtext()（见上方注释），这里写原始文案即可，
// 不要再手工写 `\:` —— 那样会被转义两次。
const source = drawtext({
  text: 'docs/eval/eval-result.json · docs/usage/*.md · npm test / npm run test:fixtures',
  size: 24, color: MUTED, t0: 25.5, dur: 1.0, y: 960,
});

const title = drawtext({ text: TITLE, font: FONT_BD, size: 52, color: INK, t0: 0.5, dur: 1.2, y: 120 });
const hairline = `drawbox=x=760:y=196:w=400:h=2:color=${RED}@0.55:t=fill:enable='between(t,0.4,30)'`;

const filter = [
  hairline,
  title,
  ...header,
  ...rowParts,
  note868,
  ...honestParts,
  source,
  `fade=t=out:st=28.8:d=1.2:color=white`,
].join(',');

console.log('[seg6] 渲染中… 30s × 1920×1080');
const t0 = Date.now();

// 【参数顺序】与段① 同一个坑：-vf 必须紧跟它所作用的输入
try {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${PAPER}:s=${W}x${H}:r=30:d=30`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', filter,
    '-map', '0:v:0', '-map', '1:a:0',
    '-shortest',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    OUT,
  ], { stdio: 'inherit', encoding: 'utf8' });
} catch (e) {
  // stdio:'inherit' 时 stderr 已在控制台；这里兜底再打一次，防被外层吞掉
  console.error('=== ffmpeg 失败 ===');
  console.error(e.stderr ?? e.message);
  process.exit(1);
}

console.log(`[seg6] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${OUT}`);

const probe = execFileSync('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate',
  '-show_entries', 'format=duration,size',
  '-of', 'default=noprint_wrappers=1',
  OUT,
], { encoding: 'utf8' });
console.log('\n=== ffprobe ===');
console.log(probe.trim());

const dur = Number((probe.match(/duration=([\d.]+)/) ?? [])[1]);
const w = Number((probe.match(/width=(\d+)/) ?? [])[1]);
const h = Number((probe.match(/height=(\d+)/) ?? [])[1]);
const hasAudio = /codec_type=audio/.test(probe);
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
const checks = [
  ['1920×1080', w === 1920 && h === 1080],
  ['时长 ≈30s', dur >= 29 && dur <= 31],
  ['有音轨（静音）', hasAudio],
];
for (const [n, ok] of checks) console.log(`  ${ok ? '✔' : '✘'} ${n}`);
console.log(`  ${dur.toFixed(2)}s · ${mb} MB`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
