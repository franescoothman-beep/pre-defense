import type { Metadata } from 'next';
import { MockBadge } from '@/components/MockBadge';
import './globals.css';

export const metadata: Metadata = {
  title: '预演 · 质询台',
  description: '上传论文/项目文档/简历，三位 AI 评委轮番质询，每条结论都能点回原文那一句。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* MOCK 常驻角标：全局 header（§3.9「不标 = 评委以为你在编数据」）。
            非 mock 模式下 isMockMode() 为 false，组件返回 null，不占位。 */}
        <MockBadge variant="header" />
        {children}
      </body>
    </html>
  );
}
