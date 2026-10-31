'use client';

// app/session/[id]/page.tsx —— 聊天页（阶段 3 第 3 条 · **只做到静态评审席横条**）
//
// 【这一拍的范围，按用户指令严格收窄】
//   做：评审席横条（三个座位 / 当前说话者朱红下划线 + 呼吸点 / 已问过的降透明度）
//   不做：接流、输入框、【扫读原文思考态】、【流式光标】、【localStorage 暂存】
// 所以本文件里没有 EventSource、没有 fetch 到 /stream、没有任何 <textarea>。
// 谁要在这拍加这些，就是违背指令——下一拍才做。
//
// 【数据从哪来】这拍直接读已有的 GET /api/sessions/:id 语义（数据来自库，不来自模型），
// 所以刷新页面结果稳定、不会每次不一样 —— 这正是"静态"该有的样子。
// 注意：那个 GET 路由还没写（§3.6 里有契约），所以这里先走一个只读的本地查询接口，
// 见 app/api/sessions/[id]/route.ts。

import { useEffect, useState } from 'react';
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

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [data, setData] = useState<ApiSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    params.then(({ id }) => {
      if (alive) setSessionId(id);
    });
    return () => {
      alive = false;
    };
  }, [params]);

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
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const personas: BenchPersona[] = (data?.personas ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    focus: p.focus,
    dimension: p.dimension,
  }));

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
      </div>

      <main className="chat-shell">
        {/* L1 评审席横条：三位评委 = 一张有座位的桌子 */}
        {personas.length > 0 ? (
          <Bench
            personas={personas}
            currentId={data?.currentPersonaId ?? null}
            pastIds={data?.pastPersonaIds ?? []}
            roundLabel={(_, i) => `座位 ${i + 1} / ${personas.length}`}
          />
        ) : null}

        <div className="chat-body">
          {error ? (
            <div className="chat-placeholder">
              <h2>这场会话打不开</h2>
              <p>{error}</p>
            </div>
          ) : !data ? (
            <div className="chat-placeholder">
              <h2>正在读取评审席…</h2>
              <p>这一拍只做静态骨架，不接流。</p>
            </div>
          ) : (
            <div className="chat-placeholder">
              <h2>评审席已就位</h2>
              <p>
                当前说话者带朱红下划线与呼吸点；已经问过的人整块降透明度。
                下面的问答流、输入框、扫读原文思考态，是下一拍的事。
              </p>
              <div className="mono-note">
                SESSION {sessionId ? sessionId.slice(0, 8) : '—'} · STATE {data.state}
                {data.progress.answered > 0 ? ` · ${data.progress.answered} answered` : ''}
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
