// app/report/[id]/page.tsx —— 答辩风险报告（方向 E：朱批 · 多材质）
//
// 【这一页是什么】
// 一场质询结束后唯一的落地页。它必须回答三个问题，且三个都不许靠"看起来完成"糊过去：
//   ① 我的材料有什么洞 —— 质询风险看板（3 评委 × 4 维）+ 左栏材料风险
//   ② 我今天答得怎么样 —— 右栏临场表现（越大越好，与左侧完全不同的色阶）
//   ③ 下一步怎么办 —— 两条复练路径（改材料重审 / 再练一遍回答）
//
// 【极性铁律（C14）】risk_score 越大越糟 / performance.score 越大越好。
// 两种数字**不共名字、不共颜色映射**：risk 高=朱红，perf 高=竹青。
//
// 【C17】risk 分差只在 revise 存在；drill 只比 performance。
// drill 报告里**绝不出现风险分差**——材料一个字没改，风险分差恒等于 0，
// 那个 "−0" 会被读成"系统坏了"。
//
// 【安全】所有模型输出按纯文本渲染，绝不 dangerouslySetInnerHTML（S3）。

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  covered: boolean;
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
  round: number;
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

/** 看板一行 = 一类质疑；行头标出占这一席的评委 */
type BoardRow = {
  type: string;
  label: string;
  judgeName: string | null;
  judgeId: string | null;
  total: number;
  cells: Array<{
    dimension: Dim;
    label: string;
    count: number;
    risk_score: number | null;
    absence: number;
    asked: number;
  }>;
};

type DeltaRow = { dimension: Dim; prev: number; now: number; dir: -1 | 0 | 1 };

type ClaimDiff = {
  prevTotal: number;
  nowTotal: number;
  kept: number;
  added: Array<{ text: string; dimension: string; risk: number }>;
  removed: Array<{ text: string; dimension: string; risk: number }>;
  riskUp: Array<{ text: string; prevRisk: number; nowRisk: number }>;
  riskDown: Array<{ text: string; prevRisk: number; nowRisk: number }>;
  absenceFilled: number;
  absenceIntroduced: number;
};

type Delta = {
  kind: 'drill' | 'revise';
  risk: DeltaRow[];
  perf: DeltaRow[];
  claims?: ClaimDiff;
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
  delta?: Delta | null;
  context?: {
    sessionId: string;
    docId: string;
    docName: string;
    mode: string;
    modeLabel: string;
    state: string;
    endedAt: string | null;
    judgeCount: number;
    mains: number;
    mainsPlanned: number;
    personas: Array<{ id: string; name: string; role: string; dimension: Dim }>;
    trajectory: Trajectory[];
    drillFrom: string | null;
    board: BoardRow[];
    overallRisk: number | null;
    overallPerf: number | null;
    mock: boolean;
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
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<ReportResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 展开原文的那一条（点引用卡片时打开） */
  const [opened, setOpened] = useState<OpenedCite | null>(null);
  /** 复练开场中（drill 需要先建一场新会话） */
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

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
   * 打开的是**被引用的那一句**与它在原文里的位置（BLOCK / P / §）。
   * absence 型没有原句可引，所以不可点开——不给"点了会有什么"的假暗示。
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

  /**
   * 再练一遍回答（drill）。
   *
   * 【为什么是新建一场而不是重放这一场】drill 的语义是"同一个材料、换一次答"，
   * 必须有一份新的 turns 才能比较临场表现；在旧会话上重答会污染那份已经作为证据的报告。
   * drillFrom 指回本场，报告页才知道要比对谁。
   */
  const startDrill = async () => {
    const ctx = data?.context;
    if (!ctx) return;
    setStarting(true);
    setStartErr(null);
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: ctx.docId, mode: 'drill', drillFrom: ctx.sessionId }),
      });
      const j = await r.json();
      if (!j.ok || !j.sessionId) {
        setStartErr(j.message ?? `开不了场（${r.status}）`);
        return;
      }
      router.push(`/session/${j.sessionId}`);
    } catch {
      setStartErr('网络中断，没能开场。请重试。');
    } finally {
      setStarting(false);
    }
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
  const board = ctx?.board ?? [];
  const delta = data.delta ?? null;
  const totalClaims = risk.reduce((s, r) => s + r.claims, 0);
  const perfCovered = perf.filter((p) => p.score !== null).length;
  const empty = risk.length === 0 && perf.length === 0;

  return (
    <>
      {/* ── 深墨封面带：全站唯一的深色块，报告的身份 ── */}
      <header className="report-cover">
        <div className="report-cover-inner">
          <div className="report-cover-row">
            <div>
              <span className="report-kicker">
                {ctx?.mode === 'revise' ? '改后重审 · 答辩风险报告' : ctx?.mode === 'drill' ? '复练 · 临场表现报告' : '答辩风险报告'}
              </span>
              <h1 className="report-title">{ctx?.docName ?? '材料'}</h1>
              <div className="report-meta">
                <span>{ctx?.modeLabel ?? ''}</span>
                {ctx ? (
                  <span>
                    主问 {ctx.mains} / {ctx.mainsPlanned} · 评委 {ctx.judgeCount} 位
                  </span>
                ) : null}
                {ctx?.endedAt ? <span>{fmtTime(ctx.endedAt)}</span> : null}
                {data.degraded ? (
                  <span className="report-degraded">报告模型调用失败，本文由服务端聚合与模板生成</span>
                ) : null}
              </div>
            </div>
            {/*
              朱印：全场材料风险。
              分数由质疑点聚合（服务端），这里只是放大显示——不放任何模型措辞。
            */}
            <div className="report-stamp" aria-label="材料风险总分">
              <span className="stamp-num">{ctx?.overallRisk ?? '—'}</span>
              <span className="stamp-cap">材料风险 / 100</span>
            </div>
          </div>
        </div>
      </header>

      <main className="report-shell">
        {empty ? (
          <div className="report-placeholder">
            <h2>这份报告没有数据</h2>
            <p>本场没有任何问答记录，也没有抽到质疑点，因此无法给出风险与表现评估。</p>
            <p className="report-note">回到材料页重新抽取质疑点后再开一场。</p>
          </div>
        ) : null}

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

        {/* ── 审议轨迹（紧凑条）：谁在第几轮、给了几分 ── */}
        {ctx && ctx.trajectory.length > 0 ? (
          <section className="trace-strip" aria-label="审议轨迹">
            <span className="trace-lb">审议轨迹</span>
            {ctx.trajectory.map((t) => (
              <span key={t.turnId} className="trace-node" title={`${t.personaName}：${t.question}`}>
                <i className={t.score === null ? '' : scoreDotCss(t.score)} />
                <span className="trace-r">
                  {t.kind === 'followup' ? '追' : 'R'}
                  {t.seq}
                </span>
                <span className="trace-s">{t.score === null ? '—' : t.score}</span>
              </span>
            ))}
          </section>
        ) : null}

        {/* ── 质询风险看板：3 评委 × 4 维 ── */}
        {board.length > 0 ? (
          <section className="board" aria-label="质询风险看板">
            <div className="board-hd">
              <h2 className="report-col-title">
                质询风险看板
                <span className="report-polarity">满分 100 · 越高越危险</span>
              </h2>
              <p className="board-legend">
                <span className="legend-r">■ 红色 = 高风险</span>
                <span className="legend-g">■ 绿色 = 已安全</span>
                <span className="legend-x">点击任意格子 → 跳到这一类质疑点清单</span>
              </p>
            </div>
            <table className="board-t">
              <thead>
                <tr>
                  <th className="board-lead">评委 / 维度</th>
                  {DIMS.map((d) => (
                    <th key={d}>
                      <i className="board-sq" style={{ background: `var(--dim-${d})` }} />
                      {DIM_CN[d]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.map((row) => (
                  <tr key={row.type}>
                    <th className="board-rowhd">
                      <b>{row.label}</b>
                      <span className="board-judge">{row.judgeName ?? '本场无此席位'}</span>
                      <span className="board-total">{row.total} 条</span>
                    </th>
                    {row.cells.map((cell) => (
                      <td key={`${row.type}-${cell.dimension}`}>
                        {cell.count === 0 ? (
                          // 材料里真的没有这一类：显示「—」，不给可点暗示
                          <span className="cell-empty" title="这一类质疑在材料里没有出现">
                            —
                          </span>
                        ) : (
                          <a
                            className="board-cell"
                            href={
                              ctx
                                ? `/doc/${ctx.docId}?dim=${cell.dimension}&type=${row.type}`
                                : '#'
                            }
                            title={`${row.label} · ${DIM_CN[cell.dimension]}：${cell.count} 条质疑点，聚合风险 ${cell.risk_score ?? '—'}${
                              cell.asked > 0 ? `，本场问过 ${cell.asked} 条` : '，本场未问到'
                            }`}
                          >
                            <span className={`cellv${riskLevelCss(cell.risk_score ?? 0)}`}>
                              {cell.risk_score ?? '—'}
                            </span>
                            <span className="cellbar" aria-hidden="true">
                              <i
                                className={riskLevelCss(cell.risk_score ?? 0)}
                                style={{ width: `${cell.risk_score ?? 0}%` }}
                              />
                            </span>
                            <span className="cellmeta">
                              {cell.count} 条{cell.asked > 0 ? ` · 问过 ${cell.asked}` : ''}
                              {cell.absence > 0 ? ` · 缺 ${cell.absence}` : ''}
                            </span>
                          </a>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {/* ── 二练对比：revise 比风险 / drill 比表现（C17）── */}
        {delta ? <DeltaBlock delta={delta} prevId={ctx?.drillFrom ?? null} /> : null}

        <div className="report-cols">
          {/* ── 左栏：材料风险（risk_score 越大越糟） ── */}
          <section className="report-col" aria-label="材料风险">
            <h2 className="report-col-title">
              材料风险
              <span className="report-polarity">越大越危险</span>
            </h2>
            <div className="col-big">
              <span className={`big-num${riskLevelCss(ctx?.overallRisk ?? 0)}`}>
                {ctx?.overallRisk ?? '—'}
              </span>
              <span className="big-note">
                {totalClaims} 条质疑点聚合 · 衡量材料，不衡量你
              </span>
            </div>

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
                          if (l.kind === 'absence') return;
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

          {/* ── 右栏：临场表现（score 越大越好，颜色与左栏完全不同） ── */}
          <section className="report-col" aria-label="临场表现">
            <h2 className="report-col-title">
              临场表现
              <span className="report-polarity">越大越好</span>
            </h2>
            <div className="col-big">
              <span className="big-num is-good">{ctx?.overallPerf ?? '—'}</span>
              <span className="big-note">
                {perfCovered > 0 ? `本场问到 ${perfCovered} 维 · 衡量你的答，不衡量材料` : '本场没有问到任何维度'}
              </span>
            </div>

            {perf.map((p) => (
              <article key={p.dimension} className="perf-card">
                <div className="perf-head">
                  <span className="perf-dim">{p.label}</span>
                  {p.score === null ? (
                    <span className="perf-uncovered">本场未问到</span>
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
                {h.quote && !h.actionable ? <p className="high-quote">「{h.quote}」</p> : null}
                {h.page !== null && h.page !== undefined ? (
                  <span className="high-where">
                    {h.section ? `${h.section} · ` : ''}P{h.page} · BLOCK {h.blockIdx}
                  </span>
                ) : h.blockIdx !== undefined && h.blockIdx >= 0 ? (
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

        {/* ── 审议轨迹（明细）：谁问了什么、我怎么答的、给了几分 ── */}
        {ctx && ctx.trajectory.length > 0 ? (
          <section className="report-trajectory" aria-label="审议轨迹明细">
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

        {/* ── 两条复练路径：报告的价值在"下一步"，不在"看完了" ── */}
        {ctx ? (
          <section className="report-actions" aria-label="复练">
            <h2 className="report-col-title">接着练</h2>
            <div className="actions-row">
              <button className="act-btn" type="button" onClick={startDrill} disabled={starting}>
                {starting ? '正在排席位…' : '再练一遍回答'}
                <span className="act-sub">同一份材料 · 只比临场表现</span>
              </button>
              <button
                className="act-btn is-ghost"
                type="button"
                onClick={() => router.push(`/upload?revise=${encodeURIComponent(ctx.sessionId)}`)}
              >
                改完材料再看一次
                <span className="act-sub">上传改后材料 · 比材料风险与质疑点增删</span>
              </button>
            </div>
            <p className="actions-ghost">
              REVISE = 比对材料风险　　DRILL = 比对临场表现
              <br />
              两条路各比各的：练回答不会让材料风险下降，改材料也不会提高你的临场分。
            </p>
            {startErr ? (
              <div className="err">
                <span className="code">E_START</span>
                {startErr}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* MOCK 角标：回放数据必须当场说清楚，不能让演示数据被当成真实模型输出 */}
        {ctx?.mock ? (
          <p className="report-foot">
            MOCK 演示模式 · 本报告的所有评委发言均为录制回放，不是实时模型输出。
          </p>
        ) : null}
      </main>
    </>
  );
}

/**
 * 二练对比块。
 *
 * 【为什么两类对比长得不一样，而不是一张"统一差值表"】
 * revise 比的是**材料**（风险降 = 好）；drill 比的是**你**（表现升 = 好）。
 * 合成一张表就要让读者自己记住"哪一列是完全反过来的"，读错的代价是把好转当成恶化。
 * 所以这里按 kind 分叉：revise 只出现风险行与质疑点增删；drill 只出现表现行。
 * **drill 永远不出现风险分差**（C17）——材料没换，那个差恒等于 0。
 */
function DeltaBlock({ delta, prevId }: { delta: Delta; prevId: string | null }) {
  const isRevise = delta.kind === 'revise';
  const rows = isRevise ? delta.risk : delta.perf;
  const claims = delta.claims;
  const nothing = rows.length === 0 && (!claims || (claims.added.length === 0 && claims.removed.length === 0 && claims.riskUp.length === 0 && claims.riskDown.length === 0 && claims.absenceFilled === 0 && claims.absenceIntroduced === 0));

  return (
    <section className="delta" aria-label="二练对比">
      <h2 className="report-col-title">
        {isRevise ? '材料风险分差' : '临场表现分差'}
        <span className="report-polarity">
          {isRevise ? '负值 = 风险下降 = 改对了' : '正值 = 表现提升'}
          {prevId ? ` · 对比上一场 ${prevId.slice(0, 8)}…` : ''}
        </span>
      </h2>

      {nothing ? (
        <p className="delta-empty">
          与上一场没有可比项：两场覆盖的维度不相交，或各项分数没有变化。
          这不是"没有改善"，而是"这一次没法比"。
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="delta-rows">
          {rows.map((r) => {
            const diff = r.now - r.prev;
            // revise：风险下降是好事（绿）；drill：表现上升是好事（绿）
            const good = isRevise ? diff < 0 : diff > 0;
            return (
              <div className="delta-row" key={`${delta.kind}-${r.dimension}`}>
                <span className="delta-dim">{DIM_CN[r.dimension]}</span>
                <span className="delta-from">{r.prev}</span>
                <span className="delta-arrow">→</span>
                <span className="delta-to">{r.now}</span>
                <span className={`delta-val ${good ? 'is-good' : 'is-bad'}`}>
                  {diff > 0 ? '+' : ''}
                  {diff}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {isRevise && claims ? (
        <div className="claim-diff">
          <p className="cd-sum">
            质疑点 <b>{claims.prevTotal}</b> → <b>{claims.nowTotal}</b> 条 · 两场都还在 {claims.kept} 条
            {claims.absenceFilled > 0 ? ` · 补上原文 ${claims.absenceFilled} 条` : ''}
            {claims.absenceIntroduced > 0 ? ` · 反而引不出原文 ${claims.absenceIntroduced} 条` : ''}
          </p>
          {claims.removed.length > 0 ? (
            <div className="cd-group">
              <span className="cd-label is-good">改掉了 {claims.removed.length} 条</span>
              <ul>
                {claims.removed.map((c, i) => (
                  <li key={`rm-${i}`}>
                    <span className="cd-dim">{DIM_CN[c.dimension as Dim] ?? c.dimension}</span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {claims.added.length > 0 ? (
            <div className="cd-group">
              <span className="cd-label is-bad">新出现 {claims.added.length} 条</span>
              <ul>
                {claims.added.map((c, i) => (
                  <li key={`ad-${i}`}>
                    <span className="cd-dim">{DIM_CN[c.dimension as Dim] ?? c.dimension}</span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {claims.riskDown.length > 0 ? (
            <div className="cd-group">
              <span className="cd-label is-good">风险下调 {claims.riskDown.length} 条</span>
              <ul>
                {claims.riskDown.map((c, i) => (
                  <li key={`dn-${i}`}>
                    <span className="cd-risk">
                      {c.prevRisk} → {c.nowRisk}
                    </span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {claims.riskUp.length > 0 ? (
            <div className="cd-group">
              <span className="cd-label is-bad">风险上调 {claims.riskUp.length} 条</span>
              <ul>
                {claims.riskUp.map((c, i) => (
                  <li key={`up-${i}`}>
                    <span className="cd-risk">
                      {c.prevRisk} → {c.nowRisk}
                    </span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isRevise ? (
        // drill 必须自证"我没有风险分差"，否则读者会以为漏了一块
        <p className="delta-note">
          这一场材料一个字没改，所以风险分不会变——drill 只比你的临场表现。
          想让材料风险下降，请走「改完材料再看一次」。
        </p>
      ) : null}
    </section>
  );
}

const DIMS: Dim[] = ['logic', 'evidence', 'depth', 'expression'];

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

/** 判分 5 档 → 轨迹圆点颜色（低分是危险的，用朱红；高分用竹青） */
function scoreDotCss(score: number): string {
  if (score >= 4) return 'is-good';
  if (score >= 3) return 'is-mid';
  return 'is-bad';
}

/** ISO 时间 → 本地「MM-DD HH:mm」（报告的落款时间） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
