import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pdfjs-dist 在 Node 侧运行，不能被打包器压缩
  serverExternalPackages: ['pdfjs-dist'],
  experimental: { },
};

export default nextConfig;
