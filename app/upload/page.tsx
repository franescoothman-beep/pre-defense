'use client';

// app/upload/page.tsx —— 上传页（方向 E：暖纸 · 朱批）
//
// 这个页面的职责就是一件事：把「这个文件到底被解析成了什么」说清楚。
// 所以它必须同时显示：已解析 N 页 / M 块、mode（paged 还是 flow）、
// density（是不是薄材料），以及前 3 块原文预览——让用户一眼看出「解析没坏」。
//
// 不做的：样式美化之外的功能、质疑点抽取、LLM 调用。

import { useCallback, useEffect, useRef, useState } from 'react';
import './upload.css';

type PreviewBlock = {
  idx: number;
  page: number | null;
  section: string | null;
  text: string;
};

type DocResult = {
  docId: string;
  name: string;
  pages: number | null;
  chars: number;
  mode: 'paged' | 'flow';
  density: 'thin' | 'normal' | 'heavy';
  blocks: number;
  preview: PreviewBlock[];
};

type DocRow = {
  id: string;
  name: string;
  pages: number | null;
  chars: number;
  mode: string;
  density: string;
  created_at: string;
};

type Fail = { code: string; message: string };

/** 演示模式下的内置样例（由 /api/demo 提供） */
type DemoDoc = {
  docId: string;
  name: string;
  pages: number | null;
  chars: number;
  mode: string;
  density: string;
  claims: number;
};

const MODE_LABEL: Record<string, string> = {
  paged: 'PAGED · 有物理页',
  flow: 'FLOW · 无物理页',
};

const DENSITY_LABEL: Record<string, string> = {
  thin: 'THIN · 材料偏薄，将走通用质询',
  normal: 'NORMAL',
  heavy: 'HEAVY · 材料很厚',
};

export default function UploadPage() {
  const [hot, setHot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [doc, setDoc] = useState<DocResult | null>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  /**
   * 演示模式标记。
   *
   * 【为什么不直接读环境变量】这是 client component，读不到服务端的 MOCK_LLM。
   * 由 `/api/health` 带出来（服务端知道真相），前端只是照着置灰。
   * 注意：**前端置灰只是提示，真正的拦截在服务端**（见 lib/demo.ts 的注释）——
   * 绕过前端有无数种办法，只有服务端拒绝才算拦住。
   */
  const [mockMode, setMockMode] = useState(false);
  /** 演示模式下可用的内置样例（读不到时为 null，界面给出可读原因） */
  const [demoDoc, setDemoDoc] = useState<DemoDoc | null>(null);
  const [demoErr, setDemoErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 复练「revise」的上一场会话 id（从报告页的「改完材料再看一次」带过来）。
   *
   * 【为什么要一路透传到 doc 页】revise 的语义是"同一份作品的新版本重新送审"，
   * 少了这个 id，重审就变成一场孤立的普通评审 —— 报告里不会有风险分差，
   * 用户也就看不到"改材料到底把风险降低了多少"，而这恰恰是 revise 唯一的说服力。
   */
  const [reviseFrom, setReviseFrom] = useState<string | null>(null);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('revise');
    if (v) setReviseFrom(v);
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await fetch('/api/docs', { cache: 'no-store' });
      const j = await r.json();
      if (j.ok) setDocs(j.docs ?? []);
    } catch {
      /* 列表拉不到不影响上传主流程 */
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 读一次演示模式标记（health 里带 mock 字段）
  useEffect(() => {
    let alive = true;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { ok?: boolean; mock?: boolean }) => {
        if (alive && j.ok) setMockMode(Boolean(j.mock));
      })
      .catch(() => {
        /* 读不到就按真实模式展示：宁可多给一个入口，也不要在真实模式下把上传锁死 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 演示模式下取内置样例（给"一键进入"用）
  useEffect(() => {
    if (!mockMode) return;
    let alive = true;
    fetch('/api/demo', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { ok?: boolean; message?: string } & Partial<DemoDoc>) => {
        if (!alive) return;
        if (j.ok) setDemoDoc(j as DemoDoc);
        else setDemoErr(j.message ?? '演示库中还没有可用的内置样例。');
      })
      .catch(() => {
        if (alive) setDemoErr('读不到演示样例，请确认服务已启动。');
      });
    return () => {
      alive = false;
    };
  }, [mockMode]);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setFail(null);
      setDoc(null);
      setPct(0);

      // 进度条走 XHR，因为 fetch 拿不到上传进度
      const body = new FormData();
      body.append('file', file);

      const xhr = new XMLHttpRequest();
      const done = new Promise<{ ok: boolean; data: unknown }>((resolve) => {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          try {
            const j = JSON.parse(xhr.responseText);
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: j });
          } catch {
            resolve({ ok: false, data: { message: '服务端返回了无法解析的响应。' } });
          }
        };
        xhr.onerror = () => resolve({ ok: false, data: { message: '网络中断，上传失败。' } });
      });

      xhr.open('POST', '/api/docs');
      xhr.send(body);

      const res = await done;
      setBusy(false);

      if (!res.ok) {
        const d = res.data as Partial<Fail>;
        setFail({ code: d.code ?? 'E_UNKNOWN', message: d.message ?? '上传失败。' });
        return;
      }

      const j = res.data as { ok: boolean } & DocResult;
      setPct(100);
      setDoc(j);
      void loadList();
    },
    [loadList],
  );

  const onPick = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (f) void upload(f);
    },
    [upload],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setHot(false);
      if (busy) return;
      onPick(e.dataTransfer?.files ?? null);
    },
    [busy, onPick],
  );

  return (
    <>
      <div className="ribbon">
        <b>预演 · 质询台</b>
        <span>UPLOAD · 材料接入</span>
        <span style={{ marginLeft: 'auto' }}>阶段 1 · 解析与锚点接线</span>
      </div>

      <main className="shell">
        <h1 className="wordmark">
          预演<span className="dot">。</span>
        </h1>
        <p className="lede">
          先把你准备好的材料交给质询台。系统会逐页取文本、切成可溯源的文本块——
          后面三位评委说的每一句质疑，都要能点回这里的某一块原文。
        </p>

        {/* 改后重审：明确告诉用户"这次上传会被当成上一场那份材料的新版本" */}
        {reviseFrom ? (
          <div className="err" style={{ borderLeftColor: 'var(--dim-depth)', background: 'var(--paper-2)' }}>
            <span className="code" style={{ color: 'var(--dim-depth)' }}>改后重审</span>
            你正在为上一场（{reviseFrom.slice(0, 8)}…）提交<b>改后的材料</b>。
            重审出的报告会显示材料风险分差，以及两次之间质疑点的增删——
            这是唯一能证明「风险真的降下来了」的路径。
          </div>
        ) : null}

        <div className="frame">
          {/*
            演示模式拦截提示（§3.9 前提①）
            —— 置灰 + 明确说明，而不是让用户上传完才发现失败。
            真正的拦截在服务端（POST /api/docs 用内容指纹判定），这里只负责不误导。
          */}
          {mockMode && (
            <div className="mock-block" role="note">
              <p className="mb-hd">演示模式仅支持内置样例</p>
              <p className="mb-tx">
                当前是 MOCK 演示模式：所有评委发言都是录制回放，因此只能使用内置样例
                <b> sample-paper.docx</b>。上传别的材料没有对应回放剧本，
                评委将无法据此提问——所以这里直接禁止，而不是让你传到一半才失败。
              </p>
              <p className="mb-how">
                要看自己的材料：把 <code>MOCK_LLM</code> 设为 <code>0</code> 并配置模型密钥，重启服务。
              </p>
              {/* 不能只拦住却不给下一步：演示模式必须有一条明确的入口 */}
              <div className="mb-next">
                {demoDoc ? (
                  <>
                    <span className="mb-doc">
                      {/* pages 为 null 表示 DOCX 这类没有物理页的格式，
                          不能用破折号当代替 —— 那读起来像"数据缺失"，
                          而事实是"这种格式本来就没有页"。 */}
                      {demoDoc.name} · {demoDoc.pages !== null ? `${demoDoc.pages} 页` : '无物理页'} /{' '}
                      {demoDoc.chars} 字 · {demoDoc.claims} 条质疑点
                    </span>
                    <a className="btn" href={`/doc/${demoDoc.docId}`} style={{ textDecoration: 'none' }}>
                      用内置样例开始 →
                    </a>
                  </>
                ) : demoErr ? (
                  <span className="mb-doc is-err">{demoErr}</span>
                ) : (
                  <span className="mb-doc">正在查找内置样例…</span>
                )}
              </div>
            </div>
          )}

          <div
            className={`drop${hot ? ' hot' : ''}${mockMode ? ' disabled' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!mockMode) setHot(true);
            }}
            onDragLeave={() => setHot(false)}
            onDrop={(e) => {
              if (mockMode) {
                e.preventDefault();
                return; // 演示模式：拖拽也不接受（不静默接手）
              }
              onDrop(e);
            }}
            onClick={() => !busy && !mockMode && inputRef.current?.click()}
            role="button"
            tabIndex={mockMode ? -1 : 0}
            aria-disabled={mockMode}
            onKeyDown={(e) => {
              if (mockMode) return;
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
          >
            <p className="hint">
              {mockMode
                ? '上传已在演示模式下禁用'
                : busy
                  ? `正在解析… ${pct}%`
                  : '把 PDF 或 DOCX 拖到这里'}
            </p>
            <p className="sub">
              {mockMode
                ? '改用内置样例 · 详见上方说明'
                : '支持 .pdf / .docx · 单文件 ≤ 20MB · PPTX 暂不支持'}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf"
              hidden
              disabled={mockMode}
              onChange={(e) => onPick(e.target.files)}
            />
            {busy && (
              <div className="bar" style={{ marginTop: 20 }}>
                <i style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>

          {fail && (
            <div className="err">
              <span className="code">{fail.code}</span>
              {fail.message}
            </div>
          )}

          {doc && (
            <>
              <div className="stat">
                <span>
                  已解析 <b>{doc.pages ?? '—'}</b> 页 / <b>{doc.blocks}</b> 块
                </span>
                <span>
                  字符 <b>{doc.chars}</b>
                </span>
                <span>{MODE_LABEL[doc.mode] ?? doc.mode}</span>
                <span>{DENSITY_LABEL[doc.density] ?? doc.density}</span>
              </div>

              {doc.density === 'thin' && (
                <div className="err" style={{ borderLeftColor: 'var(--line-2)', background: 'var(--paper-2)' }}>
                  <span className="code" style={{ color: 'var(--muted)' }}>材料信息密度偏低</span>
                  这份材料能被追问的原文不多。后续会切换成「通用答辩问题」口径提出质疑，
                  这类质疑没有可引用原文，会显式标成「缺失」而不是编一句引用。
                </div>
              )}

              <div className="preview">
                <p className="hd">前 3 块原文预览 · 溯源的最小单位</p>
                {doc.preview.map((b) => (
                  <div className="blk" key={b.idx}>
                    <p className="where">
                      {b.page !== null ? `P${b.page}` : b.section ?? '无章节'}
                      {' · '}BLOCK {b.idx}
                    </p>
                    <p>{b.text}</p>
                  </div>
                ))}
                <div style={{ padding: '4px 20px 18px' }}>
                  <a
                    className="btn"
                    href={`/doc/${doc.docId}${reviseFrom ? `?revise=${encodeURIComponent(reviseFrom)}` : ''}`}
                    style={{ textDecoration: 'none', display: 'inline-block' }}
                  >
                    {reviseFrom ? '进入质疑点抽取（改后重审）→' : '进入质疑点抽取 →'}
                  </a>
                </div>
              </div>
            </>
          )}
        </div>

        {docs.length > 0 && (
          <div className="frame list">
            <p className="hd">已接入的材料</p>
            {docs.map((d) => (
              <div className="row" key={d.id}>
                <span className="nm">{d.name}</span>
                <span className="mt">
                  {d.pages !== null ? `${d.pages}P` : 'FLOW'} · {d.chars}字 · {d.density}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
