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
  const inputRef = useRef<HTMLInputElement>(null);

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

        <div className="frame">
          <div
            className={`drop${hot ? ' hot' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setHot(true);
            }}
            onDragLeave={() => setHot(false)}
            onDrop={onDrop}
            onClick={() => !busy && inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
          >
            <p className="hint">{busy ? `正在解析… ${pct}%` : '把 PDF 或 DOCX 拖到这里'}</p>
            <p className="sub">支持 .pdf / .docx · 单文件 ≤ 20MB · PPTX 暂不支持</p>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf"
              hidden
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
