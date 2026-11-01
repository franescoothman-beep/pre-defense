// app/report/[id]/page.tsx —— 报告页（阶段 4 最小可用版；阶段 5 补两栏/看板/复练）
//
// 【为什么阶段 4 就要有这一页】
// C11 要求「报告永不缺席」。若 /end 生成完报告却没有一个能打开的页面，
// 那"报告永不缺席"只是一句 JSON 里的自我声明——用户点了「结束并出报告」，
// 跳到 404，等于产品在最关键的一步断掉。
//
// 【这一页的目标：把已有数据如实读出来，不假装已完成】
// 已经落库的东西全部展示：材料风险（服务端聚合）、临场表现（模型给分）、
// 高风险清单（可点回原文那一句）、覆盖缺口。
// 阶段 5 才做的是：两栏版式定稿、质询风险看板（3 评委 × 4 维矩阵热力）、
// 引用命中脉冲动效、复练入口（drill / revise）。
// 这里用一个显式的「后续」条目写清楚，而不是让页面看起来已经完工。
//
// 【极性铁律（C14）】risk_score 越大越糟 / performance.score 越大越好。
// 两种数字必须用不同的颜色语义：risk 高=朱红（危险），perf 高=竹青（好）。
// 颜色只编码数据，不当装饰。

'use client';

import { useEffect, useState } from 'react';
import './report.css';

type Dim = 'logic' | 'evidence' | 'depth' | 'expression';

type Locator = {
  blockIdx: number;
  page: number | null;
  section: string | null;
  quote: string;
  kind: 'quote' | 'absence';
  scope?: string;
  verified?: 0 | 1 | null;
};

type MaterialRisk = {
  dimension: Dim;
  label: string;
  risk_score: number | null;
  claims: number;
  absence: number;
  /** 材料在这一维上有没有质疑点（与"本场问没问过"是两件事） */
  covered: boolean;
  /** 本场有没有真的在这一维上问过 */
  askedInSession?: boolean;
  comment: string;
  locators: Locator[];
};

type Performance = {
  dimension: Dim;
  label: string;
  score: number | null;
  comment: string;
  covered: boolean;
};

type HighRisk = {
  claimId: string;
  dimension: string;
  risk: number;
  actionable: boolean;
  question?: string;
  why?: string;
  suggestion?: string;
  quote?: string;
  section?: string | null;
  page?: number | null;
  blockIdx?: number;
  text?: string;
};

type Coverage = {
  risk: { covered: number; total: number };
  perf: { covered: number; total: number };
  note: string;
  askedDimensions?: string[];
  absentDimensions?: string[];
};

type Trajectory = {
  turnId: string;
  seq: number;
  kind: string;
  personaName: string;
  dimension: Dim | null;
  question: string;
  answer: string | null;
  score: number | null;
  verifiedOk: number | null;
  claimId: string | null;
  blockIdx: number | null;
  page: number | null;
  section: string | null;
  quote: string;
  locatorKind: string | null;
};

type ReportResp = {
  ok?: boolean;
  code?: string;
  message?: string;
  reportId?: string;
  degraded?: boolean;
  material_risk?: MaterialRisk[];
  performance?: Performance[];
  coverage?: Coverage | null;
  high_risk?: HighRisk[];
  advice?: string;
  context?: {
    docName: string;
    mode: string;
    modeLabel: string;
    judgeCount: number;
    mains: number;
    mainsPlanned: number;
    personas: Array<{ id: string; name: string; role: string; dimension: Dim }>;
    trajectory: Trajectory[];
  } | null;
};

/** 被点开的那一条引用（用于在报告里就地展示被引用的原句） */
type OpenedCite = {
  blockIdx: number;
  page: number | null;
  section: string | null;
  quote: string;
  kind: 'quote' | 'absence';
  scope?: string;
  verified?: 0 | 1 | null;
};

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<ReportResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 展开原文的那一条（点引用卡片时打开） */
  const [opened, setOpened] = useState<OpenedCite | null>(null);

  useEffect(() => {
    let alive = true;
    params.then(({ id: rid }) => {
      if (alive) setId(rid);
    });
    return () => {
      alive = false;
    };
  }, [params]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/reports/${id}`)
      .then(async (r) => {
        const j = (await r.json()) as ReportResp;
        if (!r.ok || j.ok === false) throw new Error(j.message ?? `读取失败（${r.status}）`);
        return j;
      })
      .then((j) => {
        if (alive) {
          setData(j);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  /**
   * 点开一条 quote 出处。
   *
   * 【这一拍确实"点开了"，只是打开的是被引用的那一句】
   * 完整"定位到原文那一句并高亮上下文"需要整块原文 —— 报告接口在阶段 5 才带 text。
   * 现在能展示的是 locator 自带的 quote 与 page/section，这就足够回答
   * "评委这句话到底在批评什么"。**不做一个点了什么都不发生的假交互**。
   */
  const openSource = (l: Locator) => {
    setOpened({
      blockIdx: l.blockIdx,
      page: l.page,
      section: l.section,
      quote: l.quote,
      kind: l.kind,
      scope: l.scope,
      verified: l.verified,
    });
  };

  if (loading) {
    return (
      <main className="report-shell">
        <div className="report-placeholder">正在读取报告…</div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="report-shell">
        <div className="report-placeholder">
          <h2>报告打不开</h2>
          <p>{error ?? '没有数据'}</p>
          <p className="report-note">若你还没结束本场，请在聊天页点「结束并出报告」。</p>
        </div>
      </main>
    );
  }

  const ctx = data.context;
  const risk = data.material_risk ?? [];
  const perf = data.performance ?? [];
  const high = data.high_risk ?? [];

  return (
    <>
      {/* 深墨封面带：报告的唯一一件"重色块" */}
      <header className="report-cover">
        <div className="report-cover-inner">
          <span className="report-kicker">答辩风险报告</span>
          <h1 className="report-title">{ctx?.docName ?? '材料'}</h1>
          <div className="report-meta">
            <span>{ctx?.modeLabel ?? ''}</span>
            {ctx ? (
              <span>
                主问 {ctx.mains} / {ctx.mainsPlanned} · 评委 {ctx.judgeCount} 位
              </span>
            ) : null}
            {data.degraded ? (
              <span className="report-degraded">报告模型调用失败，本文由服务端聚合与模板生成</span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="report-shell">
        {/* 覆盖缺口：quick 档只问 3 问，必然覆盖不满 4 维 —— 必须如实写 */}
        {data.coverage ? (
          <div className="report-coverage">
            <b>{data.coverage.note}</b>
            {data.coverage.absentDimensions && data.coverage.absentDimensions.length > 0 ? (
              <span>
                · 本场未覆盖：{data.coverage.absentDimensions.map((d) => DIM_CN[d as Dim] ?? d).join('、')}
                （材料里没有该维度的质疑点，或本场轮次没排到）
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="report-cols">
          {/* ── 左栏：材料风险（risk_score 越大越糟） ── */}
          <section className="report-col" aria-label="材料风险">
            <h2 className="report-col-title">
              材料风险
              <span className="report-polarity">越大越危险</span>
            </h2>
            {risk.map((r) => (
              <article key={r.dimension} className="risk-card">
                <div className="risk-card-head">
                  <span className="risk-dim">{r.label}</span>
                  {r.risk_score === null ? (
                    <span className="risk-uncovered">材料无此维</span>
                  ) : (
                    <>
                      <b className={`risk-score${riskLevelCss(r.risk_score)}`}>{r.risk_score}</b>
                      <span className="risk-claims">
                        {r.claims} 条质疑点{r.absence > 0 ? ` · ${r.absence} 条可补` : ''}
                      </span>
                    </>
                  )}
                </div>
                {/*
                  两个"未覆盖"是不同的事，必须分开标注：
                    · risk_score === null  → 材料本身没有这一维的质疑点（改不了，只能换材料）
                    · askedInSession === false → 本场没轮到这一维（切 full 档可以覆盖到）
                  混成一句话会让用户不知道该怎么办。
                */}
                {r.risk_score !== null && r.askedInSession === false ? (
                  <p className="risk-unasked">本场未问到这一维 · 切 full 档可覆盖</p>
                ) : null}
                {/* 风险条：长度=分值，颜色=危险等级（只编码数据） */}
                {r.risk_score !== null ? (
                  <div className="risk-bar" aria-hidden="true">
                    <i className={riskLevelCss(r.risk_score)} style={{ width: `${r.risk_score}%` }} />
                  </div>
                ) : null}
                <p className="risk-comment">{r.comment}</p>
                {r.locators.length > 0 ? (
                  <div className="risk-locators">
                    {r.locators.map((l, i) => (
                      <button
                        key={i}
                        type="button"
                        className={`locator-btn${l.kind === 'absence' ? ' is-absence' : ''}${
                          l.kind !== 'absence' && l.verified === 1 ? ' is-hit' : ''
                        }`}
                        disabled={l.kind === 'absence'}
                        onClick={() => {
                          if (l.kind === 'absence') return; // absence 显灰且不可点开（无原文可开）
                          openSource(l);
                        }}
                        title={
                          l.kind === 'absence'
                            ? `查过 ${l.scope ?? l.section ?? '未标注'}，没有可引用的句子（不可点开）`
                            : `BLOCK ${l.blockIdx}${l.page !== null ? ` · P${l.page}` : ''}${l.verified === 1 ? ' · 逐字命中' : ' · 未命中'}`
                        }
                      >
                        {l.kind === 'absence'
                          ? `缺失 · ${l.scope ?? l.section ?? '未标注'}`
                          : `BLOCK ${l.blockIdx}${l.page !== null ? ` · P${l.page}` : ''}${l.verified === 1 ? ' ✓' : ''}`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </section>

          {/* ── 右栏：临场表现（score 越大越好） ── */}
          <section className="report-col" aria-label="临场表现">
            <h2 className="report-col-title">
              临场表现
              <span className="report-polarity">越大越好</span>
            </h2>
            {perf.map((p) => (
              <article key={p.dimension} className="perf-card">
                <div className="perf-head">
                  <span className="perf-dim">{p.label}</span>
                  {p.score === null ? (
                    <span className="perf-uncovered">未覆盖</span>
                  ) : (
                    <span className="perf-score">{p.score}</span>
                  )}
                </div>
                {p.score !== null ? (
                  <div className="perf-track" aria-hidden="true">
                    <i style={{ width: `${p.score}%` }} />
                  </div>
                ) : null}
                {p.comment ? <p className="perf-comment">{p.comment}</p> : null}
              </article>
            ))}
          </section>
        </div>

        {/* 点开引用后就地展示「被引用的那一句」。这是个真实的打开：有原句、有位置、有机检结论。 */}
        {opened ? (
          <section className="report-opened" aria-label="被引用的原文">
            <div className="opened-head">
              <b>
                BLOCK {opened.blockIdx}
                {opened.page !== null ? ` · P${opened.page}` : ''}
              </b>
              {opened.section ? <span>· {opened.section}</span> : null}
              <span className={`opened-verified${opened.verified === 1 ? ' is-ok' : ''}`}>
                {opened.verified === 1 ? '✓ 逐字命中原文' : opened.verified === 0 ? '未命中原文' : '缺失类（无原句可引）'}
              </span>
              <button className="opened-close" type="button" onClick={() => setOpened(null)}>
                收起
              </button>
            </div>
            {opened.kind === 'absence' ? (
              <p className="opened-body is-absence">
                这是「该写没写」的质疑：查过 <b>{opened.scope ?? opened.section ?? '未标注'}</b>，
                原文里没有可引用的句子——所以要改材料，而不是改这一句。
              </p>
            ) : (
              <p className="opened-body">「{opened.quote}」</p>
            )}
            {opened.kind !== 'absence' ? (
              <p className="opened-note">
                这里展示的是被引用的那一句与它在原文里的位置。
                「连整段上下文一起打开并在句中高亮」属于阶段 5 的引用卡片定稿。
              </p>
            ) : null}
          </section>
        ) : null}

        {/* ── 高风险清单 ── */}
        {high.length > 0 ? (
          <section className="report-high" aria-label="最可能被追问崩的点">
            <h2 className="report-col-title">
              最可能被追问崩的点
              <span className="report-polarity">按危险程度排序</span>
            </h2>
            {high.map((h, i) => (
              <article key={h.claimId} className="high-item">
                <div className="high-head">
                  <b className="high-rank">{String(i + 1).padStart(2, '0')}</b>
                  <span className="high-dim">{DIM_CN[h.dimension as Dim] ?? h.dimension}</span>
                  <span className="high-risk">风险 {h.risk}/5</span>
                  {h.actionable ? <span className="high-actionable">改材料即可消除</span> : null}
                </div>
                <p className="high-text">{h.text ?? ''}</p>
                {h.question ? (
                  <p className="high-q">
                    <span className="high-label">评委可能会问</span>
                    {h.question}
                  </p>
                ) : null}
                {h.why ? (
                  <p className="high-why">
                    <span className="high-label">为什么会崩</span>
                    {h.why}
                  </p>
                ) : null}
                {h.suggestion ? (
                  <p className="high-sug">
                    <span className="high-label">改材料怎么改</span>
                    {h.suggestion}
                  </p>
                ) : null}
                {h.quote && !h.actionable ? (
                  <p className="high-quote">「{h.quote}」</p>
                ) : null}
                {h.page !== null && h.page !== undefined ? (
                  <span className="high-where">
                    {h.section ? `${h.section} · ` : ''}P{h.page} · BLOCK {h.blockIdx}
                  </span>
                ) : h.blockIdx !== undefined ? (
                  <span className="high-where">BLOCK {h.blockIdx}</span>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}

        {/* ── 总建议 ── */}
        {data.advice ? (
          <section className="report-advice">
            <h2 className="report-col-title">下一步</h2>
            <p>{data.advice}</p>
          </section>
        ) : null}

        {/* ── 审议轨迹：按 turn 顺序列出谁问了什么、我怎么答的、给了几分 ── */}
        {ctx && ctx.trajectory.length > 0 ? (
          <section className="report-trajectory" aria-label="审议轨迹">
            <h2 className="report-col-title">
              审议轨迹
              <span className="report-polarity">{ctx.trajectory.length} 条</span>
            </h2>
            {ctx.trajectory.map((t) => (
              <article key={t.turnId} className="tr-item">
                <div className="tr-head">
                  <span className="tr-seq">{String(t.seq).padStart(2, '0')}</span>
                  <b className="tr-name">{t.personaName}</b>
                  {t.kind === 'followup' ? <span className="tr-kind">追问</span> : null}
                  {t.dimension ? <span className="tr-dim">{DIM_CN[t.dimension]}</span> : null}
                  {t.score !== null ? <span className="tr-score">{t.score}/5</span> : null}
                  {t.verifiedOk === 0 ? <span className="tr-unverified">出处未命中</span> : null}
                </div>
                <p className="tr-q">{t.question}</p>
                <p className="tr-a">
                  <span className="tr-label">你的回答</span>
                  {t.answer === null || t.answer === '' ? '（未作答）' : t.answer}
                </p>
              </article>
            ))}
          </section>
        ) : null}

        {/* 阶段 5 的入口位置：显式写出来，而不是让页面看起来已经完工 */}
        <section className="report-next">
          <h2 className="report-col-title">本页尚未完成的部分</h2>
          <ul>
            <li>
              <b>质询风险看板</b>（3 评委 × 4 维矩阵热力 + 点格子跳 claim 列表）—— 阶段 5
            </li>
            <li>
              <b>两栏版式定稿</b>与「引用命中脉冲 320ms」动效 —— 阶段 5
            </li>
            <li>
              <b>两条复练路径</b>：后天练回答（只比临场表现）／改材料重审（比风险分差）—— 阶段 5
            </li>
            <li>
              本场数据<b>已全部落库且可直接复算</b>：材料风险分由质疑点聚合，同一批质疑点永远算出同一个数。
            </li>
          </ul>
        </section>
      </main>
    </>
  );
}

const DIM_CN: Record<Dim, string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};

/** 风险等级 → CSS 类（只编码数据，不当装饰） */
function riskLevelCss(score: number): string {
  if (score >= 70) return ' is-high';
  if (score >= 40) return ' is-mid';
  return ' is-low';
}
