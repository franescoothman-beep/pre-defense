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
  /** 这份材料的 id —— 右侧原文侧栏要靠它取全篇 */
  docId?: string;
  /** 已答过的问答（服务端解析好 gaps/locators 后给出，前端不再 JSON.parse 库里的字符串） */
  history?: HistoryItem[];
};

/**
 * 一条已答问答。
 *
 * 【为什么回答正文必须由服务端回传】
 * 提交后原本 `setAnswer('')` 把输入框清空，判分卡只留分数与缺口——
 * 用户再也看不到自己刚写的那段话，刷新更是连问过什么都丢。
 * 而"我答了什么、评委怎么判"必须是一条可回看的时间线，否则录屏里
 * 观众只能看到分数，看不到论证本身。
 */
type HistoryItem = {
  turnId: string;
  seq: number;
  round: number;
  kind: 'question' | 'followup';
  personaId: string;
  personaName: string | null;
  personaDimension: BenchDimension | null;
  question: string;
  answer: string | null;
  score: number | null;
  gaps: string[];
  locators: Array<{
    blockIdx: number;
    page: number | null;
    section: string | null;
    quote: string;
    kind: 'quote' | 'absence';
    scope?: string;
    verified: 0 | 1 | null;
    reason?: string;
  }>;
  verifiedOk: 0 | 1 | null;
  anchor: {
    claimId: string;
    blockIdx: number;
    page: number | null;
    section: string | null;
    quote: string;
    locatorKind: 'quote' | 'absence';
    verified: 0 | 1 | null;
  } | null;
  createdAt: string | null;
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
  /** 被引用的那一句原文（不是整块）——右侧侧栏用它在本块里打高亮 */
  quote?: string;
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

/** 材料的一段原文（右侧侧栏用；来自 GET /api/docs/[id]/blocks） */
type DocBlock = {
  idx: number;
  page: number | null;
  section: string | null;
  text: string;
};

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
    /** 与 SSE meta 同口径：右侧原文栏靠它在本块里打高亮 */
    quote?: string;
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
  /**
   * 刚才提交的那段回答原文。
   *
   * 【为什么判分面板要带着回答】
   * 提交后输入框会被清空（那是正确的，否则用户会以为要再交一次）。
   * 但清空之后，页面上就只剩"分数 + 缺口"，**自己刚写的论证整段消失了**——
   * 录制时这正是最尴尬的镜头：评委问什么、你怎么答，观众只看到分数。
   * 所以判分面板自己保存一份原文，答完立刻可见；更早的问答交给 history。
   */
  answer: string;
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
  /**
   * 这个 verdict 属于哪一问。
   *
   * 【为什么必须记住它】
   * 判分面板要在"用户正看着的地方"显示刚答完的这一问（含回答原文 + 分数）；
   * 而 history 是整场的时间线，也会包含同一问。两者若都渲染，屏幕上就会出现
   * 一模一样的问答两遍。用 turnId 把「当前这一问」从 history 里剔掉，
   * 等下一问开流后再自然并入 history —— 既不重复，也不丢。
   */
  const [verdictTurnId, setVerdictTurnId] = useState<string | null>(null);
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

  /**
   * 已答问答（本地乐观追加 + 服务端权威列表）。
   *
   * 【为什么要有本地这一份，不直接读 data.history】
   * 提交成功后立刻要把"我刚才答了什么"显示出来。只依赖 reloadSession 的话，
   * 会有一小段"判分已出、回答却不见"的空窗——而这正是原本被吐槽的那个观感
   * （提交后只留判分卡、回答正文凭空消失）。所以先按 /answer 响应本地拼一条，
   * 再让服务端的 history（含解析好的 gaps/locators）覆盖回来。
   */
  const [pendingHistory, setPendingHistory] = useState<HistoryItem[]>([]);

  /**
   * 这份材料的全篇段落（右侧原文侧栏用）。
   *
   * 【为什么整篇都取下来】
   * 扫读区只拿得到 meta.source —— **当前这一块**的原文。用户点「回到原文」时
   * 看到的永远是一个孤零零的片段，判断不了这句话在整篇里处在什么位置、
   * 前后说了什么。而"能追回原文那一句"恰恰是本作品的核心卖点：
   * 只给一句 = 只证明了字符串存在，给全篇上下文才证明"这句话在原意里成立"。
   *
   * 取一次缓存在 state：原文是**材料级**的，不随对话推进变化。
   */
  const [blocks, setBlocks] = useState<DocBlock[] | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const origRef = useRef<HTMLDivElement | null>(null);
  const origCurRef = useRef<HTMLButtonElement | null>(null);

  /**
   * 侧栏里"我自己翻到的那一段"，null = 跟着评委走。
   *
   * 【为什么需要一个单独的 state，而不是直接把当前块滚过去】
   * 侧栏有两个不同的"焦点"：评委此刻在读哪一段（跟着对话走，作者是评委），
   * 和用户此刻想看哪一段（跟着鼠标走，作者是用户）。
   * 前者不能因为用户翻了一下就改变——那会让人以为评委换了材料；
   * 后者也不能被每一问的开流强行拽回去——用户正看到一半。
   * 所以拆成两层：peek 只影响"看哪儿"，不影响任何判定。
   *
   * 【为什么新一轮开流要收回跟随】
   * 录屏时评委换了段，侧栏却还停在上一轮手点的地方，看起来就像坏了。
   * 新一问意味着"评委去读别处了"，此刻自动收回跟随最符合直觉，
   * 而用户想再翻回来，点一下就行。
   */
  const [peekIdx, setPeekIdx] = useState<number | null>(null);

  /** 评委此刻在读的块（来自 SSE meta），null = 还没开问 */
  const currentBlockIdx = meta?.blockIdx ?? null;
  /** 侧栏实际该停在的那一块 */
  const viewIdx = peekIdx ?? currentBlockIdx;
  /** 是否正翻在别处（决定页头显示"查看"还是"当前"、要不要给回程按钮） */
  const isPeeking = peekIdx !== null && peekIdx !== currentBlockIdx;

  /**
   * 跳到某一段。再点同一段 = 收回跟随。
   * 点"当前块"本身没有意义（它已经是跟随位置），所以也当作收回处理。
   */
  const gotoBlock = useCallback(
    (idx: number) => {
      setPeekIdx((prev) => (prev === idx || idx === currentBlockIdx ? null : idx));
    },
    [currentBlockIdx],
  );

  /**
   * 评委换了一块读 → 收回用户的翻页。
   *
   * 【为什么不能把这个判断塞进 gotoBlock】
   * gotoBlock 只在用户点的时候跑；评委换块的时机在 SSE meta 里，
   * 那时候根本没人在点。两件事得分开写，否则"用户翻了、评委也翻了"
   * 会看成一个事件，谁先谁后都说不清。
   */
  useEffect(() => {
    setPeekIdx(null);
  }, [currentBlockIdx]);

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

  // ---------- 2.5) 取这份材料的全篇原文（右侧侧栏用） ----------
  //
  // 【为什么按 docId 取一次就够】
  // 原文是材料级的，整场对话推进不会改它一个字符；而会话 GET 是每次换问都会刷的
  // 轮询接口，把全篇塞进去等于每次刷新都重传一遍。所以单独取一次，缓存在 state。
  const docId = data?.docId ?? null;
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    setBlocksError(null);
    fetch(`/api/docs/${docId}/blocks`)
      .then(async (r) => {
        const j = (await r.json()) as { ok?: boolean; message?: string; blocks?: DocBlock[] };
        if (!r.ok || j.ok === false) throw new Error(j.message ?? `原文加载失败（${r.status}）`);
        if (alive) setBlocks(j.blocks ?? []);
      })
      .catch((e: Error) => {
        if (alive) setBlocksError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [docId]);

  // ---------- 2.6) 让"正在看的那一块"停在侧栏中间 ----------
  //
  // 【为什么要居中而不是滚到顶部】
  // 用户看的是"这句话在原意里成立吗"，答案在**上下文**里 —— 前面怎么铺垫、后面怎么接。
  // 把当前块顶到最上方，前文就整块被切掉了。居中让前后两次呼吸都在视野内。
  //
  // 【为什么按 viewIdx 找而不是用 ref】
  // 焦点既可能是评委在读的块，也可能是用户手点的块；ref 只能挂一个。
  // 用 data-idx 从容器里查，两块的身份差异就只剩一个数字，逻辑不用分叉。
  useEffect(() => {
    const box = origRef.current;
    if (!box || viewIdx === null) return;
    const el = box.querySelector<HTMLElement>(`[data-idx="${viewIdx}"]`);
    if (!el) return;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    box.scrollTop += elRect.top - boxRect.top - box.clientHeight / 2 + elRect.height / 2;
  }, [viewIdx, blocks]);

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
    // 【先把提交这一刻的画面钉住】
    // 下面三处分支都会 setAnswer('') / setDoneInfo(null) / setMeta(追问)，
    // 一旦先走分支，"我刚答了什么、答的是哪一问"就全被覆盖了。
    // 所以进入网络请求前就把快照取好；之后无论走哪条分支都用这份快照。
    const answeredTurnId = doneInfo.turnId;
    const answeredText = answer;
    const answeredQuestion = streamText;
    const answeredMeta = meta;
    setSubmitting(true);
    setAnswerError(null);
    setVerdict(null);

    try {
      const r = await fetch(`/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: answeredTurnId, answer: answeredText }),
      });
      const j = (await r.json()) as AnswerResp;

      if (!r.ok || j.ok === false) {
        setAnswerError(j.message ?? `提交失败（${r.status}）`);
        return;
      }

      // 判分结果（可能是降级：evaluation 为 null）
      // 带着回答原文：判分面板自己也要能显示"我答的是这段话"。
      if (j.evaluation) {
        setVerdict({
          score: j.evaluation.score,
          scorePercent: j.evaluation.scorePercent,
          gaps: j.evaluation.gaps,
          verifiedOk: j.evaluation.verifiedOk,
          locators: j.evaluation.locators,
          degraded: Boolean(j.degraded),
          answer: answeredText,
        });
      } else if (j.degraded) {
        setVerdict({
          score: -1, scorePercent: 0, gaps: [], verifiedOk: 0, locators: [], degraded: true,
          answer: answeredText,
        });
      }
      setVerdictTurnId(answeredTurnId);

      // 同时落进问答记录：追问分支不会重开 SSE，服务端 history 要等下一次 reload，
      // 本地这条保证"答完立刻可见"，之后再由服务端同 turnId 的那条覆盖（带完整 quote/locators）。
      const askedBy = answeredMeta?.persona ?? personaNameOf(data, answeredMeta?.personaId ?? data?.currentPersonaId ?? null);
      const askedDim = personaDimOf(data, answeredMeta?.personaId ?? data?.currentPersonaId ?? null);
      setPendingHistory((prev) => [
        ...prev.filter((h) => h.turnId !== answeredTurnId),
        {
          turnId: answeredTurnId,
          seq: prev.length + 1,
          round: answeredMeta?.qIndex ?? 0,
          kind: answeredMeta?.kind === 'followup' || isFollowup ? 'followup' : 'question',
          personaId: answeredMeta?.personaId ?? '',
          personaName: askedBy,
          personaDimension: askedDim,
          question: answeredQuestion,
          answer: answeredText,
          score: j.evaluation?.score ?? null,
          gaps: j.evaluation?.gaps ?? [],
          locators: j.evaluation?.locators ?? [],
          verifiedOk: j.evaluation?.verifiedOk ?? null,
          anchor: answeredMeta
            ? {
                claimId: answeredMeta.claimId,
                blockIdx: answeredMeta.blockIdx,
                page: answeredMeta.page ?? null,
                section: answeredMeta.section ?? null,
                quote: answeredMeta.quote ?? '',
                locatorKind: answeredMeta.locatorKind ?? 'quote',
                verified: answeredMeta.verified ?? null,
              }
            : null,
          createdAt: new Date().toISOString(),
        },
      ]);

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
          quote: j.followup.quote ?? '',
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
      // 上一问已经靠 verdict 面板展示过；换个新问题时把面板收掉，
      // 这一问随之并进 history（verdictTurnId 清空后 filter 不再排除它）。
      setVerdict(null);
      setVerdictTurnId(null);
      setOpenSeq((n) => n + 1);
      reloadSession(sessionId).catch(() => { /* 静态信息刷新失败不影响答题 */ });
    } catch (e) {
      setAnswerError(`提交失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, doneInfo, submitting, answer, draftKey, reloadSession, meta, streamText, isFollowup, data]);

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

  // 【服务端 history 为准，本地乐观条目只补"服务端还没回话的那一瞬"】
  // 合并规则：同 turnId 时服务端覆盖本地（服务端有解析好的 gaps/locators/quote）；
  // 服务端没有的（刚提交、reload 还没回）保留本地。按 seq 排序保证"问→答→追问"的先后。
  // 再剔掉 verdictTurnId：刚答完的那一问已经由下方判分面板完整显示（含回答原文），
  // 若 history 也渲染一遍，屏幕上会出现一模一样的问答两遍。
  const serverHistory = data?.history ?? [];
  const serverIds = new Set(serverHistory.map((h) => h.turnId));
  const history: HistoryItem[] = [...serverHistory, ...pendingHistory.filter((h) => !serverIds.has(h.turnId))]
    .filter((h) => h.turnId !== verdictTurnId)
    .sort((a, b) => a.seq - b.seq);

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
            <div className="chat-cols">
              <div className="chat-main">
                {/* 已答问答：把「问 → 答 → 判分」按时间线留在这里。
                    放在当前问题之上，因为观众读的顺序就是"前面问过什么、我怎么答的"。 */}
              {history.length > 0 ? (
                <section className="history" aria-label="已答记录">
                  {history.map((h) => (
                    <article key={h.turnId} className="hist-item">
                      <div className="hist-q">
                        <span className="hist-seq">第 {h.round} 问</span>
                        {h.kind === 'followup' ? <span className="turn-followup">追问</span> : null}
                        <span className="hist-who">{h.personaName ?? '评委'}</span>
                      </div>
                      <p className="hist-qtext">{h.question}</p>
                      {h.answer ? (
                        <div className="hist-a">
                          <span className="hist-a-label">我的回答</span>
                          <p className="hist-atext">{h.answer}</p>
                        </div>
                      ) : null}
                      {h.score !== null ? (
                        <div className="hist-score">
                          <span className="hist-score-num">{h.score}</span>
                          <span className="hist-score-of">/ 5</span>
                          {h.verifiedOk !== null ? (
                            <span className={`verdict-verified${h.verifiedOk ? ' is-ok' : ' is-bad'}`}>
                              {h.verifiedOk ? '✓ 出处已机检' : '出处未命中'}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {h.gaps.length > 0 ? (
                        <ul className="verdict-gaps">
                          {h.gaps.map((g, i) => (
                            <li key={i}>{g}</li>
                          ))}
                        </ul>
                      ) : null}
                      {/* 出处条跟着一起留存：判分卡被收进历史后，"这一答引了哪几句原文"
                          不能随之消失 —— 那是本作品溯源能力的展示面 */}
                      {h.locators.length > 0 ? (
                        <div className="verdict-locators">
                          <span className="verdict-label">出处</span>
                          {h.locators.map((l, i) =>
                            // quote 可点：点一下就把它读到侧栏正中（"一键追回原文那一句"）。
                            // absence 不渲染成按钮 —— 它证明的是"原文里没有这句话"，
                            // 没有可跳的目标，做成按钮等于骗人点。
                            l.kind === 'absence' ? (
                              <span
                                key={i}
                                className={`locator locator-${l.kind}${l.verified === 1 ? ' is-hit' : ''}`}
                                title={l.reason}
                              >
                                {`缺失 · 查过 ${l.scope ?? l.section ?? '未标注'}`}
                              </span>
                            ) : (
                              <button
                                key={i}
                                type="button"
                                className={`locator locator-${l.kind} locator-jump${l.verified === 1 ? ' is-hit' : ''}`}
                                title={l.reason}
                                onClick={() => gotoBlock(l.blockIdx)}
                              >
                                {`BLOCK ${l.blockIdx}${l.page !== null ? ` · P${l.page}` : ''}`}
                                {l.verified === 1 ? ' ✓' : ''}
                              </button>
                            ),
                          )}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </section>
              ) : null}

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

              {/* 判分结果：**回答原文 + 分数 + gaps + 出处机检**
                  【为什么回答原文也在这里】
                  提交后输入框会被清空（正确：否则用户会以为要再交一次），
                  但清空之后若只剩分数，用户就再也看不到自己刚写的论证——
                  录制时这一镜头里观众会看到"评委问→分数出现"，中间的作答凭空消失。
                  所以判分面板自带一份回答快照；更早的问答由 history 承载。 */}
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

                  {verdict.answer ? (
                    <div className="verdict-answer">
                      <span className="verdict-label">我的回答</span>
                      <p className="verdict-answer-text">{verdict.answer}</p>
                    </div>
                  ) : null}

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
                      {verdict.locators.map((l, i) =>
                        l.kind === 'absence' ? (
                          <span
                            key={i}
                            className={`locator locator-${l.kind}${l.verified === 1 ? ' is-hit' : ''}`}
                            title={l.reason}
                          >
                            {`缺失 · 查过 ${l.scope ?? l.section ?? '未标注'}`}
                          </span>
                        ) : (
                          <button
                            key={i}
                            type="button"
                            className={`locator locator-${l.kind} locator-jump${l.verified === 1 ? ' is-hit' : ''}`}
                            title={l.reason}
                            onClick={() => gotoBlock(l.blockIdx)}
                          >
                            {`BLOCK ${l.blockIdx}${l.page !== null ? ` · P${l.page}` : ''}`}
                            {l.verified === 1 ? ' ✓' : ''}
                          </button>
                        ),
                      )}
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
              </div>

              {/*
                右侧原文栏：把「当前这一块」放回整篇里。
                【为什么不替换掉左边那个扫读区】
                扫读区是**思考态**——证明"评委现在正在读这几行"，是过程的一部分，
                离开当前问题卡就不成立。侧栏是**定位器**——回答"这句话在整篇里的位置"，
                要能上下滚、要看前后文。两者回答的不是同一个问题，所以都在。
                侧栏整篇一次取回（材料级、不随对话变化），只把当前块高亮并居中。
              */}
              <aside className="orig" aria-label="原文全篇">
                <div className="orig-head">
                  <b>原文</b>
                  {isPeeking && viewIdx !== null ? (
                    <span className="orig-head-peek">· 查看 BLOCK {viewIdx}</span>
                  ) : currentBlockIdx !== null ? (
                    <span>· 当前 BLOCK {currentBlockIdx}</span>
                  ) : null}
                  {blocks ? <span>· 全篇 {blocks.length} 段</span> : null}
                  {/* 回程按钮只在"翻到别处"时出现：没翻的时候它无处可回，
                      出现反而让人以为可以点（点了什么也不会发生） */}
                  {isPeeking ? (
                    <button className="orig-back" type="button" onClick={() => setPeekIdx(null)}>
                      回到评委正在读的
                    </button>
                  ) : null}
                </div>
                <div className="orig-body" ref={origRef}>
                  {blocksError ? (
                    <p className="orig-empty">{blocksError}</p>
                  ) : !blocks ? (
                    <p className="orig-empty">正在取原文…</p>
                  ) : blocks.length === 0 ? (
                    <p className="orig-empty">这份材料没有可显示的原文段落。</p>
                  ) : (
                    blocks.map((b) => {
                      const isNow = currentBlockIdx === b.idx;
                      const isView = viewIdx === b.idx;
                      // 命中句只在"评委正在读的那一块"里标：翻到别处看上下文时，
                      // 整篇里到处亮着同一句话会让人分不清哪一句是这一问的依据。
                      const [pre, hit, post] =
                        isNow && meta?.locatorKind === 'quote' && meta?.source
                          ? splitByQuote(b.text, anchorQuote(meta, b.text))
                          : ([b.text, '', ''] as [string, string, string]);
                      return (
                        <button
                          key={b.idx}
                          type="button"
                          data-idx={b.idx}
                          ref={isView ? origCurRef : null}
                          className={`orig-block${isNow ? ' is-now' : ''}${isView && !isNow ? ' is-peek' : ''}`}
                          aria-current={isView ? 'true' : undefined}
                          title={isNow ? '评委此刻在读这一段' : `跳到 BLOCK ${b.idx}`}
                          onClick={() => gotoBlock(b.idx)}
                        >
                          <span className="orig-where">
                            BLOCK {b.idx}
                            {b.page !== null ? ` · P${b.page}` : ''}
                            {b.section ? ` · ${b.section}` : ''}
                            {isNow ? <span className="orig-tag">· 评委在读</span> : null}
                          </span>
                          <span className="orig-text">
                            {pre}
                            {hit ? <span className="hi">{hit}</span> : null}
                            {post}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </aside>
            </div>
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

/** 从会话数据里按 personaId 取评委名（找不到就说"评委"，不编一个名字） */
function personaNameOf(data: ApiSession | null, personaId: string | null): string | null {
  if (!personaId) return null;
  return data?.personas.find((p) => p.id === personaId)?.name ?? null;
}

/** 从会话数据里按 personaId 取维度（历史条目的着色依据） */
function personaDimOf(data: ApiSession | null, personaId: string | null): BenchDimension | null {
  if (!personaId) return null;
  return data?.personas.find((p) => p.id === personaId)?.dimension ?? null;
}

/** 侧栏要在这一块里标出的那一句：meta 自带 quote 就用它，没有就不标 */
function anchorQuote(meta: SseMeta, blockText: string): string {
  const q = meta.quote ?? '';
  if (!q) return '';
  // 只在本块里标：同一句话若在别处也出现，不该跟着一起亮
  return blockText.includes(q) ? q : '';
}

/*
 * 把一段原文按命中句切成「前 / 命中 / 后」。
 * 【为什么必须走文本切分】模型产出的文本一律当纯文本渲染，
 * S3 基线不允许把原文/引文塞进 HTML（quote 本身就是模型输出）。
 * 找不到就整段当前缀、命中为空，绝不猜测性改写原文。
 */
function splitByQuote(source: string, quote: string): [string, string, string] {
  if (!quote) return [source, '', ''];
  const i = source.indexOf(quote);
  if (i < 0) return [source, '', ''];
  return [source.slice(0, i), quote, source.slice(i + quote.length)];
}
