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

  const personas: BenchPersona[] = (data?.personas ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    focus: p.focus,
    dimension: p.dimension,
  }));

  const live = phase === 'opening' || phase === 'live';
  const showCursor = phase === 'opening' || phase === 'live';
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

              {/* 错误条：服务端 fallback 原样展示 */}
              {streamError ? <div className="turn-error">{streamError.fallback}</div> : null}

              {/* 状态行：告诉用户现在在等什么 */}
              <div className={`chat-status${live ? ' is-live' : ''}`}>
                {phase === 'opening' && '正在发言…'}
                {phase === 'live' && `正在发言… 已收到 ${streamText.length} 字`}
                {phase === 'done' && doneInfo?.turnId
                  ? `发言结束 · 用时 ${doneInfo.meta?.latencyMs ?? '—'}ms · 转 ${doneInfo.meta?.model ?? '—'}`
                  : null}
                {phase === 'done' && !doneInfo?.turnId ? doneInfo?.message ?? '本场已结束' : null}
                {phase === 'error' && `中断 · ${streamError?.code ?? 'error'}`}
                {phase === 'idle' && '等待开场…'}
              </div>

              {/* 说明这一拍范围（下一拍会换成输入框） */}
              {phase === 'done' && doneInfo?.turnId ? (
                <div className="chat-placeholder">
                  <h2>这一问已说完</h2>
                  <p>
                    输入框（作答）与扫读原文思考态是下一拍的事。这一拍只验流式光标：
                    出字时竖线闪烁，done 后立即消失。
                  </p>
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
