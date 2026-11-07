'use client';

// app/session/[id]/page.tsx —— 聊天页（阶段 4：作答 → 判分 → 追问 / 换人 / 出报告）
//
// 【这一拍把闭环接上了】
//   作答框不再禁用：提交 → POST /answer → 判分 + 机检 → 三种结果的一种：
//     · decision='followup' → 展示评委的追问（带「追问」标记），作答框继续用
//     · decision='ask'      → 重开一条 SSE 拿下一位/下一问
//     · decision='end'      → 立刻去 /end 出报告（报告永不缺席 C11）
//   任何时刻都能点「结束并出报告」——那是 C11 的出口，不需要等流程走完。
//
// 【为什么追问不走 SSE】
// 追问的文本已经在 /answer 的响应里（模型判分时一起产出了，非流式）。
// 若为了"统一"再走一次 SSE，会多烧一次预算、多等一次延迟，而且 momen 上
// 用户刚提交完答案，他要的是"评委马上接话"，不是再看一遍出字动画。
// 所以：追问直接展示；下一问才走 SSE（那是全新生成，值得流式）。
//
// 【为什么重开 SSE 要新建 EventSource 而不是复用】
// SSE 的连接是"一次性"的：服务端发完 done 就 close 了。
// 复用同一个实例既不会重连（我们主动 close 过），也无法换查询参数。
// 所以每拿一个新问题就必须 new EventSource。这里用 openSeq 计数触发 effect。
//
// 【动效账】本文件不新增任何动效。光标(①)、扫读光带(②)、评委切换(③) 已在别处。
// #4「引用命中脉冲 320ms」属于阶段 5 的报告引用卡片 —— 这里不碰。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bench, type BenchDimension, type BenchPersona } from '../../../components/Bench';
import './session.css';
import './ask.css';

type ApiPersona = {
  id: string;
  name: string;
  role: string;
  focus: string;
  tone: string;
  color: string;
  dimension: BenchDimension;
};

type ApiSession = {
  state: string;
  mode: string;
  modeLabel: string;
  personas: ApiPersona[];
  progress: { qIndex: number; qTotal: number; answered: number; personaCount: number };
  currentPersonaId: string | null;
  pastPersonaIds: string[];
  docName: string;
};

/** meta 事件：指出"现在是谁在问、问的是哪一条原文" */
type SseMeta = {
  persona: string;
  personaId: string;
  qIndex: number;
  qTotal: number;
  claimId: string;
  blockIdx: number;
  blockTotal?: number;
  candidateTotal?: number;
  source?: string;
  page?: number | null;
  section?: string | null;
  locatorKind?: 'quote' | 'absence';
  verified?: 0 | 1 | null;
  /** 追问沿用主问的锚点；前端据此显示「追问」标记 */
  kind?: 'question' | 'followup';
  replay?: boolean;
};

type SseDone = {
  turnId: string | null;
  turnKind?: 'question' | 'followup';
  state: string;
  progress?: { qIndex: number; qTotal: number; answered: number };
  meta?: { model: string; mock: boolean; latencyMs: number; tokens: number };
  message?: string;
};

type SseError = { code: string; fallback: string };

/** 一条已判分的评价 */
type Evaluation = {
  score: number;
  scorePercent: number;
  gaps: string[];
  verifiedOk: 0 | 1;
  locators: Array<{
    blockIdx: number;
    page: number | null;
    section: string | null;
    quote: string;
    kind: 'quote' | 'absence';
    scope?: string;
    verified: 0 | 1 | null;
    reason: string;
  }>;
};

/** /answer 的响应 */
type AnswerResp = {
  ok?: boolean;
  code?: string;
  message?: string;
  degraded?: boolean;
  evaluation: Evaluation | null;
  followup: {
    turnId: string;
    personaId: string;
    personaName: string;
    question: string;
    claimId: string;
    blockIdx: number | null;
    source: string;
    page: number | null;
    section: string | null;
    locatorKind: 'quote' | 'absence';
    verified: 0 | 1 | null;
  } | null;
  decision?: 'followup' | 'ask' | 'end';
  endReason?: string;
  nextAction?: 'stream' | 'report' | 'answer';
  state: string;
  progress?: { qIndex: number; qTotal: number; answered: number };
  budgetLeft?: number;
  reportReady?: boolean;
};

/** 流的状态机 */
type StreamPhase = 'idle' | 'opening' | 'live' | 'done' | 'error';

/** 一次作答的结果面板 */
type Verdict = {
  score: number;
  scorePercent: number;
  gaps: string[];
  verifiedOk: 0 | 1;
  locators: Evaluation['locators'];
  degraded: boolean;
};

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [data, setData] = useState<ApiSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [meta, setMeta] = useState<SseMeta | null>(null);
  const [streamText, setStreamText] = useState('');
  const [doneInfo, setDoneInfo] = useState<SseDone | null>(null);
  const [streamError, setStreamError] = useState<SseError | null>(null);
  const [swept, setSwept] = useState(false);

  /** 作答文本（localStorage 暂存，刷新不丢） */
  const [answer, setAnswer] = useState('');
  const [restored, setRestored] = useState(false);
  /** 提交中（防连点：连点会重复烧预算，且服务端会拒第二次） */
  const [submitting, setSubmitting] = useState(false);
  /** 本次作答的判分结果 */
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  /** /answer 级别的错误（与 SSE 的 streamError 分开，两者来源不同） */
  const [answerError, setAnswerError] = useState<string | null>(null);
  /** 追问模式：这一问是"咬着上一条"的追问 */
  const [isFollowup, setIsFollowup] = useState(false);
  /** 整个流程是否已收口（该去报告页） */
  const [ended, setEnded] = useState<{ reason: string } | null>(null);
  /** 出报告过程的状态 */
  const [reportState, setReportState] = useState<'idle' | 'working' | 'error'>('idle');
  const [reportError, setReportError] = useState<string | null>(null);

  /**
   * 第几次开流。每拿一个新问题就 +1，effect 依赖它重新开一条 EventSource。
   * 【为什么不用一个 boolean】boolean 没法表达"再来一次"；
   * 计数器既能让 effect 重跑，也顺带记录了本场开过几条流（排查用）。
   */
  const [openSeq, setOpenSeq] = useState(0);

  const draftKey = sessionId && doneInfo?.turnId ? `rehearsal:draft:${sessionId}:${doneInfo.turnId}` : null;
  const esRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(false);

  // ---------- 1) 拿 sessionId ----------
  useEffect(() => {
    let alive = true;
    params.then(({ id }) => {
      if (alive) setSessionId(id);
    });
    return () => {
      alive = false;
    };
  }, [params]);

  // ---------- 2) 读会话静态信息 ----------
  const reloadSession = useCallback(async (sid: string) => {
    const r = await fetch(`/api/sessions/${sid}`);
    const j = (await r.json()) as { ok?: boolean; message?: string } & Partial<ApiSession>;
    if (!r.ok || j.ok === false) throw new Error(j.message ?? `加载失败（${r.status}）`);
    setData(j as ApiSession);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    reloadSession(sessionId).catch((e: Error) => {
      if (alive) setLoadError(e.message);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, reloadSession]);

  // ---------- 3) 接 SSE 流（每次 openSeq 变化就重开一条） ----------
  useEffect(() => {
    if (!sessionId) return;
    // 已收口（出了报告 / 主问问完）就不该再开流
    if (ended) return;

    finishedRef.current = false;
    setPhase('opening');
    setStreamText('');
    setMeta(null);
    setDoneInfo(null);
    setStreamError(null);
    setSwept(false);

    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    esRef.current = es;

    es.addEventListener('meta', (ev) => {
      try {
        const m = JSON.parse((ev as MessageEvent).data) as SseMeta;
        setMeta(m);
        setPhase('live');
        setIsFollowup(m.kind === 'followup');
        setData((prev) =>
          prev
            ? {
                ...prev,
                currentPersonaId: m.personaId,
                progress: { ...prev.progress, qIndex: m.qIndex, qTotal: m.qTotal },
              }
            : prev,
        );
      } catch {
        /* meta 坏了不该炸整条流 */
      }
    });

    es.addEventListener('token', (ev) => {
      try {
        const t = JSON.parse((ev as MessageEvent).data) as { t?: string };
        if (t?.t) setStreamText((prev) => prev + t.t);
      } catch {
        /* 单个 token 坏了就跳过 */
      }
    });

    es.addEventListener('done', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as SseDone;
        setDoneInfo(d);
        if (d.turnKind) setIsFollowup(d.turnKind === 'followup');
        // done 里带 message 且没有 turnId → 本场已结束，该去出报告
        if (!d.turnId && d.message) {
          setEnded({ reason: d.message });
        }
      } catch {
        /* 同上 */
      }
      finishedRef.current = true;
      setPhase('done');
      es.close();
    });

    es.addEventListener('error', (ev) => {
      const raw = (ev as MessageEvent).data;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          const e = JSON.parse(raw) as SseError;
          setStreamError({ code: e.code, fallback: e.fallback });
        } catch {
          setStreamError({ code: 'internal', fallback: '（评委没听清，请重试）' });
        }
        finishedRef.current = true;
        setPhase('error');
        es.close();
        return;
      }
      if (finishedRef.current) return;
      setPhase('error');
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [sessionId, openSeq, ended]);

  // ---------- 4) 草稿暂存 ----------
  useEffect(() => {
    if (!draftKey) return;
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) {
        setAnswer(saved);
        setRestored(true);
      }
    } catch {
      /* 隐私模式：静默降级 */
    }
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    try {
      if (answer.trim() === '') localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, answer);
    } catch {
      /* 存不进去不能打断作答 */
    }
  }, [draftKey, answer]);

  // ---------- 5) 光带兜底 ----------
  const live = phase === 'opening' || phase === 'live';
  useEffect(() => {
    if (live) {
      setSwept(false);
      return;
    }
    if (!meta?.source || swept) return;
    const t = setTimeout(() => setSwept(true), 3200);
    return () => clearTimeout(t);
  }, [live, meta?.source, swept]);

  // ---------- 6) 提交作答 ----------
  const submit = useCallback(async () => {
    if (!sessionId || !doneInfo?.turnId || submitting) return;
    if (answer.trim() === '') {
      setAnswerError('回答是空的。哪怕只写一句"这一点我还没想清楚"，也比空白更能体现临场表现。');
      return;
    }
    setSubmitting(true);
    setAnswerError(null);
    setVerdict(null);

    try {
      const r = await fetch(`/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: doneInfo.turnId, answer }),
      });
      const j = (await r.json()) as AnswerResp;

      if (!r.ok || j.ok === false) {
        setAnswerError(j.message ?? `提交失败（${r.status}）`);
        return;
      }

      // 判分结果（可能是降级：evaluation 为 null）
      if (j.evaluation) {
        setVerdict({
          score: j.evaluation.score,
          scorePercent: j.evaluation.scorePercent,
          gaps: j.evaluation.gaps,
          verifiedOk: j.evaluation.verifiedOk,
          locators: j.evaluation.locators,
          degraded: Boolean(j.degraded),
        });
      } else if (j.degraded) {
        setVerdict({
          score: -1, scorePercent: 0, gaps: [], verifiedOk: 0, locators: [], degraded: true,
        });
      }

      // 决定下一步
      if (j.decision === 'end' || j.nextAction === 'report' || j.reportReady) {
        setEnded({ reason: j.endReason ?? '本场主问已问完，可以出报告了。' });
        // 清掉这一问的草稿：它已经提交上去了，下次进来不该还看到旧答案
        try { if (draftKey) localStorage.removeItem(draftKey); } catch { /* ignore */ }
        return;
      }

      // 追问：文本已在响应里，直接展示（不再走 SSE）
      if (j.decision === 'followup' && j.followup) {
        setDoneInfo({ turnId: j.followup.turnId, turnKind: 'followup', state: 'ASKING' });
        setMeta({
          persona: j.followup.personaName,
          personaId: j.followup.personaId,
          qIndex: j.progress?.qIndex ?? 0,
          qTotal: j.progress?.qTotal ?? 0,
          claimId: j.followup.claimId,
          blockIdx: j.followup.blockIdx ?? 0,
          source: j.followup.source,
          page: j.followup.page,
          section: j.followup.section,
          locatorKind: j.followup.locatorKind,
          verified: j.followup.verified,
          kind: 'followup',
        });
        setStreamText(j.followup.question);
        setIsFollowup(true);
        setPhase('done');
        setSwept(false);
        setAnswer('');
        setRestored(false);
        return;
      }

      // 下一问：重开一条 SSE
      setAnswer('');
      setRestored(false);
      setDoneInfo(null);
      setOpenSeq((n) => n + 1);
      reloadSession(sessionId).catch(() => { /* 静态信息刷新失败不影响答题 */ });
    } catch (e) {
      setAnswerError(`提交失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, doneInfo, submitting, answer, draftKey, reloadSession]);

  // ---------- 7) 结束并出报告（任何时刻可点，C11） ----------
  const endAndReport = useCallback(async () => {
    if (!sessionId || reportState === 'working') return;
    setReportState('working');
    setReportError(null);
    try {
      const r = await fetch(`/api/sessions/${sessionId}/end`, { method: 'POST' });
      const j = (await r.json()) as { ok?: boolean; reportId?: string; message?: string };
      if (!r.ok || j.ok === false) {
        setReportError(j.message ?? `报告生成失败（${r.status}）`);
        setReportState('error');
        return;
      }
      // 报告页在阶段 5。这一拍先给一个明确的落点，不做假页面。
      window.location.href = `/report/${sessionId}`;
    } catch (e) {
      setReportError(`报告生成失败：${(e as Error).message}`);
      setReportState('error');
    }
  }, [sessionId, reportState]);

  const personas: BenchPersona[] = (data?.personas ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    focus: p.focus,
    dimension: p.dimension,
  }));

  const showCursor = phase === 'opening' || phase === 'live';
  const currentPersonaName =
    meta?.persona ?? data?.personas.find((p) => p.id === data.currentPersonaId)?.name ?? '评委';
  const currentDim = data?.personas.find((p) => p.id === (meta?.personaId ?? data?.currentPersonaId))?.dimension;
  const canAnswer = phase === 'done' && Boolean(doneInfo?.turnId) && !ended;

  return (
    <>
      <div className="chat-ribbon">
        <b>预演</b>
        <span>{data ? data.modeLabel : '质询台'}</span>
        {data ? (
          <span>
            第 {data.progress.qIndex} / {data.progress.qTotal} 问 · 已答 {data.progress.answered}
          </span>
        ) : null}
        {/* 「结束并出报告」：任何时刻可用（C11）。放在缎带上，因为它是"随时可退"的出口 */}
        <button
          className="ribbon-end"
          type="button"
          onClick={endAndReport}
          disabled={reportState === 'working'}
          title="任何状态下都可以结束本场并立刻生成报告"
        >
          {reportState === 'working' ? '正在生成报告…' : '结束并出报告'}
        </button>
      </div>

      <main className="chat-shell">
        {personas.length > 0 ? (
          <Bench
            personas={personas}
            currentId={data?.currentPersonaId ?? null}
            pastIds={data?.pastPersonaIds ?? []}
            roundLabel={(_, i) => `座位 ${i + 1} / ${personas.length}`}
          />
        ) : null}

        <div className="chat-body">
          {loadError ? (
            <div className="chat-placeholder">
              <h2>这场会话打不开</h2>
              <p>{loadError}</p>
            </div>
          ) : (
            <>
              {(phase === 'opening' || phase === 'live' || phase === 'done') && (
                // 评委姓名与维度不再在卡片里重复一遍大字：评审席已经把当前席位高亮，
                // 这里只在无障碍标签里保留同一信息，视觉上直接进问题正文。
                <div
                  className="turn"
                  aria-label={`${currentPersonaName}${currentDim ? ` · ${DIM_CN[currentDim]}` : ''}`}
                >
                  {isFollowup ? (
                    <div className="turn-head">
                      <span className="turn-followup">追问</span>
                    </div>
                  ) : null}
                  <p className="turn-text">
                    {streamText}
                    <span className={showCursor ? 'cursor' : 'cursor is-done'} aria-hidden="true" />
                  </p>
                </div>
              )}

              {meta && meta.source ? (
                <section
                  className={`scan${live ? '' : ' is-settled'}${swept ? ' is-swept' : ''}`}
                  aria-label="评委正在读的原文"
                  onAnimationEnd={() => setSwept(true)}
                >
                  <div className="scan-head">
                    <b>BLOCK {meta.blockIdx}</b>
                    <span>/ {meta.blockTotal ?? '—'}</span>
                    <span>· 已检索 {meta.candidateTotal ?? '—'} 处候选引用</span>
                    {meta.section ? <span>· {meta.section}</span> : null}
                    <span>
                      · 本步{' '}
                      {live
                        ? '…'
                        : doneInfo?.meta?.mock || meta.replay
                          ? '系统审计日志已同步'
                          : doneInfo?.meta?.latencyMs
                            ? `${(doneInfo.meta.latencyMs / 1000).toFixed(1)}s`
                            : '—'}
                    </span>
                  </div>
                  <div className="scan-body">
                    <p className="scan-text">{meta.source}</p>
                  </div>
                </section>
              ) : null}

              {streamError ? <div className="turn-error">{streamError.fallback}</div> : null}

              {/* 判分结果：分数 + gaps + 出处机检 */}
              {verdict ? (
                <section className="verdict" aria-label="本问判分">
                  <div className="verdict-head">
                    <span className="verdict-label">本问得分</span>
                    {verdict.degraded ? (
                      <span className="verdict-degraded">（评委这次没能给出评价，回答已保存）</span>
                    ) : (
                      <>
                        <b className="verdict-score">{verdict.score}</b>
                        <span className="verdict-of">/ 5</span>
                        <span className="verdict-pct">{verdict.scorePercent}%</span>
                        <span className={`verdict-verified${verdict.verifiedOk ? ' is-ok' : ' is-bad'}`}>
                          {verdict.verifiedOk ? '✓ 出处已机检' : '出处未命中'}
                        </span>
                      </>
                    )}
                  </div>

                  {verdict.gaps.length > 0 ? (
                    <ul className="verdict-gaps">
                      {verdict.gaps.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  ) : verdict.degraded ? null : (
                    <p className="verdict-empty">这一问答清了，没有明显缺口。</p>
                  )}

                  {verdict.locators.length > 0 ? (
                    <div className="verdict-locators">
                      <span className="verdict-label">出处</span>
                      {verdict.locators.map((l, i) => (
                        <span
                          key={i}
                          className={`locator locator-${l.kind}${l.verified === 1 ? ' is-hit' : ''}`}
                          title={l.reason}
                        >
                          {l.kind === 'absence'
                            ? `缺失 · 查过 ${l.scope ?? l.section ?? '未标注'}`
                            : `BLOCK ${l.blockIdx}${l.page !== null ? ` · P${l.page}` : ''}`}
                          {l.kind !== 'absence' && l.verified === 1 ? ' ✓' : ''}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {answerError ? <div className="turn-error">{answerError}</div> : null}

              {/* 已收口：给出明确去报告页的落点 */}
              {ended ? (
                <section className="ended">
                  <h2 className="ended-title">本场结束</h2>
                  <p className="ended-reason">{ended.reason}</p>
                  <button
                    className="ended-report"
                    type="button"
                    onClick={endAndReport}
                    disabled={reportState === 'working'}
                  >
                    {reportState === 'working' ? '正在生成报告…' : '生成答辩风险报告'}
                  </button>
                  {reportError ? <div className="turn-error">{reportError}</div> : null}
                </section>
              ) : null}

              <div className={`chat-status${live ? ' is-live' : ''}`}>
                {phase === 'opening' && '正在发言…'}
                {phase === 'live' && `正在发言… 已收到 ${streamText.length} 字`}
                {phase === 'done' && doneInfo?.turnId
                  ? isFollowup
                    ? '评委接了一句追问 · 答完它再继续'
                    : doneInfo.meta
                      ? `发言结束 · 用时 ${doneInfo.meta.latencyMs}ms · 转 ${doneInfo.meta.model}`
                      : '发言结束 · 系统审计日志已同步'
                  : null}
                {phase === 'done' && !doneInfo?.turnId && !ended ? '等待下一问…' : null}
                {phase === 'error' && `中断 · ${streamError?.code ?? 'error'}`}
                {phase === 'idle' && '等待开场…'}
              </div>

              {/* 作答区 */}
              {canAnswer ? (
                <div className="answer">
                  <div className="answer-label">
                    <span>你的回答</span>
                    {restored ? <span className="restored">· 已恢复草稿</span> : null}
                  </div>
                  <textarea
                    className="answer-input"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="就这一问作答。先给结论，再给依据——评委接下来会顺着你说的追问。"
                    aria-label="作答输入框"
                    disabled={submitting}
                  />
                  <div className="answer-foot">
                    <span className="answer-count">{answer.length} 字</span>
                    <button
                      className="answer-submit"
                      type="button"
                      onClick={submit}
                      disabled={submitting || answer.trim() === ''}
                    >
                      {submitting ? '评委正在看…' : '提交并判分'}
                    </button>
                  </div>
                  <div className="answer-note">
                    草稿按「本场 + 本问」分别存到本地，刷新不丢。
                    判分会同时跑引用机检：{'\u00A0'}能点开的出处才是被原文验证过的。
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </main>
    </>
  );
}

const DIM_CN: Record<BenchDimension, string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};
