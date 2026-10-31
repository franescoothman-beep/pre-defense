'use client';

// app/session/[id]/page.tsx —— 聊天页（阶段 3 第 4 条 · **接流 + 流式光标**）
//
// 【这一拍的范围，按用户指令严格收窄】
//   做：EventSource 接 /stream 四事件 + 流式光标（竖线块 1.05s steps 明灭，done 即消失）
//   不做：输入框、【扫读原文思考态】、答案 localStorage 暂存
// 所以本文件里没有 <textarea>、没有 meta.source 的光带渲染、没有 answer 的持久化。
// 谁要在这拍加这些，就是违背指令——下一拍才做。
//
// 【为什么用 EventSource 而不是 fetch + ReadableStream】
// 四事件格式是标准 SSE，EventSource 自动处理重连与行解析，少写一套解析器
// （服务端已经把 JSON 解包好了，token 的 t 就是要显示的字，前端只做拼接）。
// 唯一的代价是 EventSource 不能自定义请求头——本接口不需要鉴权头，可接受。
// 【重要】EventSource 对非 200 或断开会自动重连，而服务端重连会走"重播"路径（meta.replay=true），
// 所以这里必须**在 done / error 之后主动 close()**，否则会无限重连刷屏。
//
// 【动效账】光标是 §3.2 清单 #1「流式 token 光标闪烁 1.05s steps」。
// 本文件不新增任何别的动效。

import { useEffect, useRef, useState } from 'react';
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
  /** 这份材料共有多少块 —— L5 的 `BLOCK 3/10` 里的 10 */
  blockTotal?: number;
  /** 这条 claim 所在维度下有几条候选引用 —— L5 的「已检索 N 处候选引用」 */
  candidateTotal?: number;
  source?: string;
  page?: number | null;
  section?: string | null;
  locatorKind?: 'quote' | 'absence';
  verified?: 0 | 1 | null;
  /** 断线重连会走重播：同一问题再吐一遍，零模型调用 */
  replay?: boolean;
};

type SseDone = {
  turnId: string | null;
  state: string;
  progress?: { qIndex: number; qTotal: number; answered: number };
  meta?: { model: string; mock: boolean; latencyMs: number; tokens: number };
  message?: string;
};

type SseError = { code: string; fallback: string };

/** 流的状态机：idle 还没开始 / live 正在出字 / done 出完 / error 出错 */
type StreamPhase = 'idle' | 'opening' | 'live' | 'done' | 'error';

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [data, setData] = useState<ApiSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [meta, setMeta] = useState<SseMeta | null>(null);
  /** 流式累积的问题文本。每收到一个 token 就追加——这就是"逐字出现" */
  const [streamText, setStreamText] = useState('');
  const [doneInfo, setDoneInfo] = useState<SseDone | null>(null);
  const [streamError, setStreamError] = useState<SseError | null>(null);

  /** 作答文本（localStorage 暂存，刷新不丢） */
  const [answer, setAnswer] = useState('');
  /** 暂存是否被恢复过（用来在界面上如实提示"已恢复草稿"） */
  const [restored, setRestored] = useState(false);

  /**
   * 扫读光带是否已经扫完一遍。
   *
   * 【为什么需要这个状态】光带一个周期 2.6s，而实测出字窗口只有约 1.0s。
   * done 时若立刻把 animation 设成 none，用户只能看到光带扫到 40% 就被掐断 ——
   * 「扫读」没完成。所以 done 只把 iterations 改成 1（CSS 会跑完当前这一遍），
   * 再由本状态（animationend 触发，另有超时兜底）真正移除光带。
   */
  const [swept, setSwept] = useState(false);

  /** localStorage 的键：带上 sessionId 与 turnId，保证"每一问各自的草稿"互不覆盖 */
  const draftKey = sessionId && doneInfo?.turnId ? `rehearsal:draft:${sessionId}:${doneInfo.turnId}` : null;

  /** 持住 EventSource，卸载时一定要 close，否则组件换了它还在重连 */
  const esRef = useRef<EventSource | null>(null);
  /** 防止 StrictMode 双挂载把流开两遍（服务端会建两条 turn） */
  const openedRef = useRef(false);
  /**
   * 已经正常收尾的标志。
   *
   * 【为什么必须有这个 ref】`es.close()` 会让浏览器**再触发一次连接层的 error 事件**
   * （raw 为空）。此时若只靠 `setPhase((p) => p === 'done' ? p : 'error')` 判断，
   * 就是在依赖"上一次 setPhase 已经被 React 应用"这个时序假设——
   * StrictMode、并发渲染、批处理都可能让 p 还是旧值，于是正常结束会被画成"中断"。
   * 用 ref 记录"我自己关的"，是即时的、不经过渲染队列的，判断才可靠。
   */
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

  // ---------- 2) 读会话静态信息（评审席用） ----------
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    fetch(`/api/sessions/${sessionId}`)
      .then(async (r) => {
        const j = (await r.json()) as { ok?: boolean; message?: string } & Partial<ApiSession>;
        if (!r.ok || j.ok === false) throw new Error(j.message ?? `加载失败（${r.status}）`);
        return j as ApiSession;
      })
      .then((j) => {
        if (alive) setData(j);
      })
      .catch((e: Error) => {
        if (alive) setLoadError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // ---------- 3) 接 SSE 流 ----------
  useEffect(() => {
    if (!sessionId) return;
    // StrictMode 会把 effect 跑两遍；第二次若再开一条流，服务端会多建一条 turn。
    // 用 ref 保证"同一个 sessionId 只开一次"，直到组件真正卸载。
    if (openedRef.current) return;
    openedRef.current = true;
    finishedRef.current = false; // 新流开始，清掉上一轮的收尾标志

    setPhase('opening');
    setStreamText('');
    setMeta(null);
    setDoneInfo(null);
    setStreamError(null);

    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    esRef.current = es;

    // 必须 addEventListener('事件名')，不能用 es.onmessage ——
    // 服务端发的是具名事件（event: meta / token / done / error），onmessage 只收"无 event 名"的默认消息。
    es.addEventListener('meta', (ev) => {
      try {
        const m = JSON.parse((ev as MessageEvent).data) as SseMeta;
        setMeta(m);
        setPhase('live'); // meta 一到就进入 live：光标从这里开始闪
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
        // meta 解析失败不该炸掉整条流：留空，后面 token 照常显示
      }
    });

    es.addEventListener('token', (ev) => {
      try {
        const t = JSON.parse((ev as MessageEvent).data) as { t?: string };
        if (t?.t) setStreamText((prev) => prev + t.t);
      } catch {
        // 单个 token 坏了就跳过，不要整条流回滚
      }
    });

    es.addEventListener('done', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as SseDone;
        setDoneInfo(d);
      } catch {
        /* 同上 */
      }
      finishedRef.current = true;
      setPhase('done'); // 光标立刻消失
      // 【必须主动关】否则 EventSource 断线会自动重连，服务端又会重播一遍，无限刷。
      // close() 之后浏览器会补发一个连接层 error，由 finishedRef 拦掉（见上面的注释）。
      es.close();
    });

    es.addEventListener('error', (ev) => {
      // 两种 error：① 服务端发的具名 error 事件（有 data）② 连接层错误（无 data）
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
      // 连接层错误：自己关的（done/error 已处理过）→ 一律忽略，不覆盖已有状态
      if (finishedRef.current) return;
      // 真正的意外断开
      setPhase('error');
    });

    return () => {
      es.close();
      esRef.current = null;
      openedRef.current = false;
    };
  }, [sessionId]);

  // ---------- 4) 作答草稿：localStorage 暂存（刷新不丢） ----------
  //
  // 【为什么按 turnId 分键】一场 quick 有 3 问。若只按 sessionId 存一个字符串，
  // 第 2 问会覆盖第 1 问的草稿——用户回头改第 1 问时发现写的东西没了。
  // 每一问各自一个键，才是"暂存"该有的语义。
  useEffect(() => {
    if (!draftKey) return;
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) {
        setAnswer(saved);
        setRestored(true);
      }
    } catch {
      // 隐私模式 / 存储被禁用：静默降级，不影响作答本身
    }
    // 只在键变化时读一次；后续输入由写入 effect 负责
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    try {
      if (answer.trim() === '') localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, answer);
    } catch {
      /* 存不进去也不能打断作答 */
    }
  }, [draftKey, answer]);

  const personas: BenchPersona[] = (data?.personas ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    focus: p.focus,
    dimension: p.dimension,
  }));

  const live = phase === 'opening' || phase === 'live';
  const showCursor = phase === 'opening' || phase === 'live';

  /**
   * 光带兜底：动画结束后一定移除；万一 animationend 没来（系统开了"减少动效"、
   * 或某些浏览器在 background-position 上不触发 animationend），用 3.2s 超时兜住。
   * 3.2s = 2.6s 一个周期 + 0.6s 余量，保证不会误伤正在跑的那一遍。
   */
  useEffect(() => {
    if (live) {
      setSwept(false);
      return;
    }
    if (!meta?.source || swept) return;
    const t = setTimeout(() => setSwept(true), 3200);
    return () => clearTimeout(t);
  }, [live, meta?.source, swept]);

  const currentPersonaName =
    meta?.persona ?? data?.personas.find((p) => p.id === data.currentPersonaId)?.name ?? '评委';
  const currentDim = data?.personas.find((p) => p.id === (meta?.personaId ?? data?.currentPersonaId))?.dimension;

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
        {/* MOCK 角标位置：这一拍还没有 mock 回放，先留位（阶段 3 第 6 条做） */}
      </div>

      <main className="chat-shell">
        {/* L1 评审席横条 */}
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
              {/* 流式发言 */}
              {(phase === 'opening' || phase === 'live' || phase === 'done') && (
                <div className="turn">
                  <div className="turn-head">
                    <h2 className="turn-name">{currentPersonaName}</h2>
                    {currentDim ? <span className="turn-dim">{DIM_CN[currentDim]}</span> : null}
                  </div>
                  <p className="turn-text">
                    {streamText}
                    {/* 光标：正在出字或等第一个字时闪；done/error 时 is-done 直接隐藏 */}
                    <span
                      className={showCursor ? 'cursor' : 'cursor is-done'}
                      aria-hidden="true"
                    />
                  </p>
                </div>
              )}

              {/*
                L5 扫读原文思考态
                —— 直接显示评委正在读的那段原文，一道朱红光带自上而下扫过 2.6s。
                三件事必须同时成立，否则它就退化成一句空泛的"思考中"：
                  ① 真实 block 文本（meta.source，服务端从 blocks 表取的整块原文）
                  ② 进度数字（BLOCK n/N · 已检索 N 处候选引用）
                  ③ 光带在"正在出字"时扫，done 之后停
              */}
              {meta && meta.source ? (
                <section
                  className={`scan${live ? '' : ' is-settled'}${swept ? ' is-swept' : ''}`}
                  aria-label="评委正在读的原文"
                  // 光带扫完一遍后打上 is-swept 真正移除它。
                  // 用 onAnimationEnd 而不是固定延时：延时只能猜，事件是确定的。
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
                        : meta.replay
                          ? '重播'
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

              {/* 错误条：服务端 fallback 原样展示 */}
              {streamError ? <div className="turn-error">{streamError.fallback}</div> : null}

              {/* 状态行：告诉用户现在在等什么 */}
              <div className={`chat-status${live ? ' is-live' : ''}`}>
                {phase === 'opening' && '正在发言…'}
                {phase === 'live' && `正在发言… 已收到 ${streamText.length} 字`}
                {phase === 'done' && doneInfo?.turnId
                  ? doneInfo.meta
                    ? `发言结束 · 用时 ${doneInfo.meta.latencyMs}ms · 转 ${doneInfo.meta.model}`
                    : '发言结束（重播，未调用模型）'
                  : null}
                {phase === 'done' && !doneInfo?.turnId ? doneInfo?.message ?? '本场已结束' : null}
                {phase === 'error' && `中断 · ${streamError?.code ?? 'error'}`}
                {phase === 'idle' && '等待开场…'}
              </div>

              {/* 作答区：流结束后才出现（这一问说完了，才轮到你答） */}
              {phase === 'done' && doneInfo?.turnId ? (
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
                  />
                  <div className="answer-foot">
                    <span className="answer-count">{answer.length} 字</span>
                    <button
                      className="answer-submit"
                      type="button"
                      disabled
                      title="判分接口属阶段 4，本拍只验草稿暂存"
                    >
                      提交并判分（阶段 4）
                    </button>
                  </div>
                  <div className="answer-note">
                    草稿按「本场 + 本问」分别存到本地，刷新不丢。
                    提交与判分属阶段 4 —— 这里故意做成禁用按钮，不做假提交：
                    一个能点但什么都不发生的按钮，比一个明确禁用并注明原因的按钮更误导人。
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
