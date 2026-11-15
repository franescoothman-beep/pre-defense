// scripts/make-seg1.mjs —— 段① 痛点字幕卡（0:00–0:30）直接生成
//
// 【为什么这段不录屏】
// 段① 是一张动态字幕卡，没有页面可点、没有鼠标轨迹、没有交互。
// 用 OBS 录只会得到"某张图停留 30 秒"，还得靠后期再剪浮现节奏；
// 直接用 ffmpeg 渲染，节奏（逐行 4 秒淡入）在脚本里就是确定的，重跑一次即可微调。
//
// 【配色为什么写死在这几个十六进制】
// 铁律 9 说"组件里不写十六进制、只走 globals.css token"。这条约束管的是**界面代码**，
// 而本脚本是离线的视频渲染工具，不在页面里跑、拿不到 CSS 变量，
// 所以从 globals.css 取值后抄在这里，并注明出处。改 token 时这里要跟着改。
//   --ink  #17150f   正文字色
//   --red  #b03a2e   朱红（末行强调）
//   --bg   #efeade   暖纸底（与正片同底，剪在一起不跳）
//
// 用法：
//   node scripts/make-seg1.mjs
//   node scripts/make-seg1.mjs --bg dark   # 用深墨底（正片封面带那套）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const BG_MODE = flag('--bg', 'paper'); // paper | dark
const OUT_DIR = path.join('docs', 'recordings');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, 'rehearsal-seg1-1080p.mp4');

// ── 配色（出处：app/globals.css :root）──
const INK = '0x17150f';
const RED = '0xb03a2e';
const PAPER = '0xefeade';
const PAPER_2 = '0xf5efe4';

const BG = BG_MODE === 'dark' ? '0x14120e' : PAPER;
const FG = BG_MODE === 'dark' ? '0xf3eee2' : INK;
const ACCENT = RED;

// ── 文字（逐字照《录制全案.md §4》，改这里要两处同步）──
const L1 = '答辩之前，你不知道评委会问哪三个问题。';
const L2 = '找 AI 聊几句？它客气、它泛泛、它不较真——';
const L3 = '更不会告诉你，它说的每一句，在你材料里到底有没有根据。';
const L4 = '「预演」做的，就是一场会翻原文的对抗质询。';

// ── 时间轴（30 秒）──
// 0.6–4.4   L1
// 4.6–9.0   L2
// 9.2–14.2  L3
// 15.0–26.5 L4（朱红，压住收尾）
// 26.5–30   静止留白，给旁白收气
const W = 1920;
const H = 1080;
const FONT = 'C\\:/Windows/Fonts/msyh.ttc'; // 微软雅黑
const FONT_BD = 'C\\:/Windows/Fonts/msyhbd.ttc';

/** 生成一行 drawtext：从 t0 淡入到满，t1 后保持 */
function drawtext({ text, font, size, color, t0, dur, y, alphaPeak = 1 }) {
  const a = `if(lt(t,${t0}),0,if(lt(t,${t0 + dur}),(t-${t0})/${dur},1))`;
  return [
    `drawtext=fontfile='${font}'`,
    `text='${text.replace(/'/g, "\\'")}'`,
    `fontsize=${size}`,
    `fontcolor=${color}@${alphaPeak}`,
    `alpha='${a}'`,
    `x=(w-text_w)/2`,
    `y=${y}`,
  ].join(':');
}

// 版式：四行竖排，靠上偏中；末行字号更大
const y0 = 300;
const gap = 96;
const parts = [
  drawtext({ text: L1, font: FONT, size: 46, color: FG, t0: 0.6, dur: 1.6, y: y0 }),
  drawtext({ text: L2, font: FONT, size: 46, color: FG, t0: 4.6, dur: 1.6, y: y0 + gap }),
  drawtext({ text: L3, font: FONT, size: 46, color: FG, t0: 9.2, dur: 1.6, y: y0 + gap * 2 }),
  drawtext({ text: L4, font: FONT_BD, size: 58, color: ACCENT, t0: 15.0, dur: 1.8, y: y0 + gap * 3 + 40 }),
];

// 底部字幕条：上传材料 → 三位 AI 评委轮番质询 → 答辩风险报告
const sub = drawtext({
  text: '上传材料  →  三位 AI 评委轮番质询  →  答辩风险报告',
  font: FONT,
  size: 30,
  color: BG_MODE === 'dark' ? '0x9a8f78' : '0x8a806d',
  t0: 17.5,
  dur: 1.6,
  y: H - 170,
});

// 顶部一条细朱线（保留品牌感，不抢字）
const hairline =
  `drawbox=x=760:y=200:w=400:h=2:color=${ACCENT}@0.55:t=fill:enable='between(t,0.3,30)'`;

const filter = [
  // 底色：不做纯黑，用暖纸或深墨，与正片同底
  hairline,
  ...parts,
  sub,
  // 整段末尾 1 秒轻微压暗收气
  `fade=t=out:st=28.8:d=1.2:color=${BG_MODE === 'dark' ? 'black' : 'white'}`,
].join(',');

console.log('[seg1] 渲染中…');
console.log(`  底色 ${BG_MODE} · 四行字幕 + 底部字幕条 · 30s ${W}×${H}`);

const t0 = Date.now();
// 【参数顺序】-vf 是"针对紧随其后那个输入的滤镜"，所以：
//   输入1 画面(color) → 输入2 静音(anullsrc) → -vf → 编码参数 → 输出
// 上一次写成 -vf 之后又塞 -f lavfi -i anullsrc，ffmpeg 把 -vf 当成了音频输入的选项，直接报错。
execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', `color=c=${BG}:s=${W}x${H}:r=30:d=30`,
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-vf', filter,
  '-map', '0:v:0', '-map', '1:a:0',
  '-shortest',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  OUT,
], { stdio: 'inherit' });

console.log(`[seg1] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${OUT}`);

// ── 验收 ──
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
