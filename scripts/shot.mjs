// scripts/shot.mjs —— 用本机 Edge 无头模式截一张页面图
// 用法：node scripts/shot.mjs <url> <outPath> [width] [height]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [url, out, w = '1280', h = '1400'] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node scripts/shot.mjs <url> <outPath> [width] [height]');
  process.exit(1);
}

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('找不到 Edge/Chrome');
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const abs = path.resolve(out);
const r = spawnSync(
  exe,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    `--screenshot=${abs}`,
    '--virtual-time-budget=4000',
    url,
  ],
  { stdio: 'inherit' },
);

if (!fs.existsSync(abs)) {
  console.error('未生成截图');
  process.exit(1);
}
console.log(`[ok] ${out} ${Math.round(fs.statSync(abs).size / 1024)} KB`);
