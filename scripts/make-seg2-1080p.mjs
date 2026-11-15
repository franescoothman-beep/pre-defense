// scripts/make-seg2-1080p.mjs —— 把 OBS 母版缩成 1080p 成片并 ffprobe 验收
//
// 【为什么缩而不是重录 1080p】
// 本机物理 2560×1600，直接 1080p 录会把 CSS 视口压到 1366×726 以下，字号掉到 15.2px。
// 文档口径是"整屏 2560×1600 录 → lanczos 缩 1920×1080"，成片正文 19.0px。
//
// 用法：node scripts/make-seg2-1080p.mjs "docs/recordings/2026-11-15 22-45-49.mkv"
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('用法：node scripts/make-seg2-1080p.mjs <母版.mkv>');
  process.exit(1);
}

const dir = path.dirname(src);
const base = path.basename(src, path.extname(src)).replace(/\s+/g, '-');
const out = path.join(dir, `rehearsal-seg2-1080p.mp4`);

console.log('母版：', src);
const t0 = Date.now();
execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  '-i', src,
  '-vf', 'scale=1920:1080:flags=lanczos',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k',
  '-movflags', '+faststart',
  out,
], { stdio: 'inherit' });
console.log(`缩放完成 ${((Date.now() - t0) / 1000).toFixed(1)}s →`, out);

// 验收
const probe = execFileSync('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,channels',
  '-show_entries', 'format=duration,size',
  '-of', 'default=noprint_wrappers=1',
  out,
], { encoding: 'utf8' });

console.log('\n=== ffprobe 验收 ===');
console.log(probe.trim());

const dur = Number((probe.match(/duration=([\d.]+)/) ?? [])[1]);
const w = Number((probe.match(/width=(\d+)/) ?? [])[1]);
const h = Number((probe.match(/height=(\d+)/) ?? [])[1]);
const hasAudio = /codec_type=audio/.test(probe);
const sizeMB = (fs.statSync(out).size / 1024 / 1024).toFixed(1);

const checks = [
  ['MP4 容器', out.endsWith('.mp4')],
  ['1920×1080', w === 1920 && h === 1080],
  ['有音轨', hasAudio],
  ['时长 ≥60s', dur >= 60],
];
console.log('');
for (const [name, ok] of checks) console.log(`  ${ok ? '✔' : '✘'} ${name}`);
console.log(`  时长 ${dur.toFixed(1)}s · ${sizeMB} MB`);
console.log(`\n母版保留：${src}（${(fs.statSync(src).size / 1024 / 1024).toFixed(1)} MB）`);
void base;
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
