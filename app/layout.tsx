import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '预演 · 质询台',
  description: '上传论文/项目文档/简历，三位 AI 评委轮番质询，每条结论都能点回原文那一句。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
