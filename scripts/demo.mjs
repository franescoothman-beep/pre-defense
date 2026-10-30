// scripts/demo.mjs —— 跨平台启动 mock 演示模式（Windows 下 `set VAR=1&&next dev` 很容易写错）
import { spawn } from 'node:child_process';

const nextBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(nextBin, ['next', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, MOCK_LLM: '1' },
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 0));
