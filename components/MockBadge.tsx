// components/MockBadge.tsx —— 「MOCK 演示模式」常驻角标
//
// 【为什么必须有，而且必须常驻】
// §3.9 原文：「常驻「MOCK 演示模式」角标：全局 header + 报告页脚注。**不标 = 评委以为你在编数据**」。
// 这不是提示友好的问题，是诚信问题：mock 模式下所有评委发言都是录好的回放，
// 若界面上看不出来，评委看到"AI 秒出高质量问题"会以为是真的模型在跑。
//
// 【为什么是服务端组件】
// 它读 process.env.MOCK_LLM —— 这是服务端才知道的事实。
// 若做成客户端组件用 NEXT_PUBLIC_ 变量，又多一份需要同步的配置，容易分叉。
// 服务端读一次、把结果直接渲染进 HTML，刷新也对得上，且客户端无法伪造。
//
// 【为什么分成 header / footer 两种形态】
// 全局 header 用横条（显眼、每页都有）；
// 报告页脚注用更小的一行（报告是"交付物"，角标不该抢正文的注意力，但也不能没有）。

import './MockBadge.css';

export function isMockMode(): boolean {
  return process.env.MOCK_LLM === '1';
}

type Props = {
  /** header：全局横条；footer：报告页脚注 */
  variant?: 'header' | 'footer';
};

export function MockBadge({ variant = 'header' }: Props) {
  if (!isMockMode()) return null;

  if (variant === 'footer') {
    return (
      <div className="mock-foot" role="note">
        MOCK 演示模式 · 本报告的所有评委发言均为录制回放，不是实时模型输出。
      </div>
    );
  }

  return (
    <div className="mock-banner" role="note" aria-label="MOCK 演示模式提示">
      <span className="mock-dot" aria-hidden="true" />
      <b>MOCK 演示模式</b>
      <span className="mock-why">
        零 key 可复现 · 评委发言为录制回放，非实时模型输出
      </span>
      <span className="mock-only">仅支持内置样例</span>
    </div>
  );
}
