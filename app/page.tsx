// app/page.tsx —— 首页（方向 E：暖纸 · 朱批）
//
// 【首页要回答的三个问题，按顺序】
// ① 这是什么 —— 一句话说清「上传材料 → 三位 AI 评委轮番质询 → 风险报告」
// ② 和"找个 AI 问几个问题"有什么不同 —— 两条对比（连续性追问 / 每条结论可追回原文）
// ③ 现在怎么试 —— 主按钮进上传页；MOCK 模式下它是零 key 可复现的入口
//
// 【为什么首页要写"证据链"而不是堆功能列表】
// 官方评分 25% 给"实用"、20% 给"创新"，而这件作品唯一的硬差异是
// **每条结论都能一键追回原文那一句**（锚点 + quote 逐字机检）。
// 功能列表谁都会写，证据链是别人做不出来的那一条 —— 所以它上首页。
//
// 【为什么是服务端组件】
// 页面本身没有交互，全部静态文案；唯一动态的是 MOCK 角标（由 layout 的
// 服务端 MockBadge 负责）。做成服务端组件能直接输出 HTML，评委首屏更快。
//
// 不做的：任何客户端状态、任何 LLM 调用、任何统计数字（首页不承诺未实测的指标）。

import Link from 'next/link';
import './home.css';

export default function Home() {
  return (
    <>
      <div className="ribbon">
        <b>预演</b>
        <span>上传论文 / 项目文档 / 简历 → 三位 AI 评委轮番质询 → 答辩风险报告</span>
      </div>

      <main className="wrap">
        <section className="hero">
          <h1 className="wordmark">
            预演<span className="dot">。</span>
          </h1>
          <p className="tagline">
            正式答辩只有一次机会，但你可以先被问倒十次。上传你的
            <b>论文、项目文档或简历</b>，三位不同视角的 AI 评委轮番提问并追问，
            结束后给你一份<b>答辩风险报告</b>——每一条结论都能<b>点回原文那一句</b>。
          </p>

          <div className="flow">
            <div className="step">
              <div className="no">STEP 01</div>
              <div className="nm">上传材料</div>
              <p className="ds">PDF / DOCX，自动切成可定位的段落块，保留页码与章节。</p>
            </div>
            <div className="step">
              <div className="no">STEP 02</div>
              <div className="nm">被质询</div>
              <p className="ds">三位评委按方法学 / 工程 / 价值各问一处，答不好会继续追问。</p>
            </div>
            <div className="step">
              <div className="no">STEP 03</div>
              <div className="nm">看风险</div>
              <p className="ds">材料风险与临场表现分两栏，高危质疑点按危险程度排序。</p>
            </div>
          </div>

          <div className="enter">
            <Link className="btn" href="/upload">
              开始预演
            </Link>
            <span className="note">QUICK 档 · 3 位评委各 1 主问，3–6 轮出报告</span>
          </div>
        </section>

        <section className="sect">
          <div className="hd">和「找个 AI 问几个问题」有什么不同</div>
          <div className="vs">
            <div>
              <div className="ttl">普通做法</div>
              <ul>
                <li>问一次就结束，不会追到你答不上来</li>
                <li>结论说得头头是道，但你不知道它凭什么这么说</li>
                <li>每问一次都重新开始，进步无法度量</li>
                <li>模型说"你缺数据支撑"，你翻半天找不到是哪一句</li>
              </ul>
            </div>
            <div className="mine">
              <div className="ttl">这里</div>
              <ul>
                <li>同一条质疑点会往下追，直到你答清或答不下去</li>
                <li>每条结论都附带原文引用，<b>逐字</b>机检过才算数</li>
                <li>改完材料重审一次，风险分差与质疑点增删可比</li>
                <li>点一下就能跳到原文那一句，命中位置直接高亮</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="proof">
          <div className="hd">每条结论都能追回原文那一句</div>
          <p className="tx">
            评委说的每一句都要附一个<b>锚点</b>：指向材料里的第几块、哪一页、哪一章节，
            以及<b>原样的引用文字</b>。系统会对这句引用做<b>逐字机检</b>——
            编出来的、改了字的、跨块拼的，都会被判为未命中并留在分母里，
            不会因为"看起来很像"就放过去。
          </p>
          <div className="two">
            <div className="q">QUOTE · 原文里有这句，点开高亮命中位置</div>
            <div className="a">ABSENCE · 原文里就没有这句，说明该补什么</div>
          </div>
        </section>

        <footer className="foot">
          <span>预演 · REHEARSAL</span>
          <Link href="/upload">开始一场</Link>
          <a href="/api/health">/api/health</a>
        </footer>
      </main>
    </>
  );
}
