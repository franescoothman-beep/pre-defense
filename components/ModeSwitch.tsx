'use client';

// components/ModeSwitch.tsx —— 运行期「演示 / 真实」模式切换控件
//
// 【为什么是 client 组件】
// 它要真的发 POST 并可能整页刷新，必须有交互能力。
// 但"当前是哪个模式"这个事实**由服务端传入**（initialMode），不在客户端猜 ——
// 客户端拉 /api/health 再渲染会让控件先空一拍，且失败时整条控件消失。
//
// 【为什么切换后整页 reload】
// 模式影响的不止这个控件：上传页的禁用态、报告页脚注、MockBadge 文案都以
// 服务端 mode 为真相。整页刷新是最稳、零残留的做法 —— 服务端按新 mode 重渲
// 全部页面，不会出现"前端切了、某页还停在旧态"的幽灵状态。
// 模式切换是低频操作，reload 的代价可接受。

import { useState } from 'react';
import './ModeSwitch.css';

type Mode = 'mock' | 'real';

export function ModeSwitch({ initialMode }: { initialMode: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function flip(next: Mode) {
    if (busy || next === mode) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.message ?? '切换失败。');
        return;
      }
      setMode(next);
      // 整页刷新，让所有页面按新 mode 重渲（含上传禁用态、角标与报告页脚注）
      window.location.reload();
    } catch {
      setErr('网络错误，切换未生效。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mode-switch" role="group" aria-label="运行模式切换">
      <button
        type="button"
        className={`seg${mode === 'mock' ? ' on' : ''}`}
        aria-pressed={mode === 'mock'}
        disabled={busy}
        onClick={() => flip('mock')}
      >
        演示 · 零 key 回放
      </button>
      <button
        type="button"
        className={`seg${mode === 'real' ? ' on' : ''}`}
        aria-pressed={mode === 'real'}
        disabled={busy}
        onClick={() => flip('real')}
      >
        真实 · 实时模型
      </button>
      {err ? <span className="ms-err" role="alert">{err}</span> : null}
    </div>
  );
}
