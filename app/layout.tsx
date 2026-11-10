import type { Metadata } from 'next';
import { MockBadge } from '@/components/MockBadge';
import { ModeSwitch } from '@/components/ModeSwitch';
import { getMode } from '@/lib/mode';
import './globals.css';

// 模式可在运行期切换（/api/mode），所以整棵布局必须按请求渲染，
// 不能构建期静态化成一张"冻结在 MOCK_LLM"的 HTML —— 否则切换后角标与开关会撒谎。
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '预演 · 质询台',
  description: '上传论文/项目文档/简历，三位 AI 评委轮番质询，每条结论都能点回原文那一句。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const mode = getMode();
  return (
    <html lang="zh-CN">
      <body>
        {/* MOCK 常驻角标：全局 header（§3.9「不标 = 评委以为你在编数据」）。
            非 mock 模式下 isMockMode() 为 false，组件返回 null，不占位。 */}
        <MockBadge variant="header" />
        {/* 运行期模式切换：演示（零 key 回放）/ 真实（实时模型）。
            它是唯一总闸 —— 切换它同时改变"上传是否只收内置样例"与"评委发言走回放还是真模型"。
            initialMode 由服务端给，避免控件先空一拍或猜错档位。 */}
        <ModeSwitch initialMode={mode} />
        {children}
      </body>
    </html>
  );
}
