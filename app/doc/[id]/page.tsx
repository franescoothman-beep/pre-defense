'use client';

// app/doc/[id]/page.tsx —— 质疑点卡片页（方向 E）
//
// 这个页面是产品的立身之本（§3.2「引用卡片，最优先实现」）。
// 它必须让评审一眼看出**两类结论是不同的东西**：
//   quote  型：可点开，展开原文并**高亮那一句**，标 ✓ 逐字命中
//   absence 型：**不可点开**，虚线灰显，标"查过这些节，没有"
//
// 【安全】高亮用**文本切分渲染**，绝不 dangerouslySetInnerHTML（S3）。
// 模型输出永远当纯文本对待。

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import './doc.css';

type Claim = {
  type: 'method' | 'engineering' | 'value';
  text: string;
  block_idx: number;
  page: number | null;
  section: string | null;
  quote: string;
  locator_kind: 'quote' | 'absence';
  scope: string | null;
  verified: 0 | 1 | null;
  risk: number;
  dimension: 'logic' | 'evidence' | 'depth' | 'expression';
  /** 整块原文（展开全文时用，前端按 quote 切分高亮） */
  source?: string;
};

type Coverage = {
  sampledBatches: number;
  totalBatches: number;
  sampled: boolean;
  skippedBatches: number;
};

type Doc = { id: string; name: string; pages: number | null; chars: number; mode: string; density: string };

const TYPE_LABEL: Record<Claim['type'], string> = {
  method: '方法论',
  engineering: '工程实现',
  value: '价值与创新',
};

const DIM_COLOR: Record<Claim['dimension'], string> = {
  logic: 'var(--dim-logic)',
  evidence: 'var(--dim-evidence)',
  depth: 'var(--dim-depth)',
  expression: 'var(--dim-expression)',
};

const DIM_LABEL: Record<Claim['dimension'], string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};

/** 把一段原文按 quote 切成「前 / 命中 / 后」三段。
 *  找不到就整段当"前"，不做任何猜测性改写。 */
function splitByQuote(source: string, quote: string): [string, string, string] {
  if (!quote) return [source, '', ''];
  const i = source.indexOf(quote);
  if (i < 0) return [source, '', ''];
  return [source.slice(0, i), quote, source.slice(i + quote.length)];
}

/** 纯文本切分高亮：把整块原文按 quote 切成「前 / 命中 / 后」三段。
 *  绝不拼接 HTML 字符串、绝不 dangerouslySetInnerHTML（S3：模型输出永远当纯文本）。 */
function Highlighted({ source, quote }: { source: string; quote: string }) {
  const [pre, hit, post] = splitByQuote(source, quote);
  return (
    <>
      {pre}
      {hit && <span className="hi">{hit}</span>}
      {post}
    </>
  );
}

export default function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [docId, setDocId] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ code: string; message: string } | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [rate, setRate] = useState<{ quote?: { total: number; hit: number; rate: number }; absence?: { total: number; ok: number; rate: number } }>({});
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  /**
   * 看板格子跳过来时带的筛选条件，以及"用改后材料重审"带的上一场 id。
   *
   * 【为什么用 window.location.search 而不是 useSearchParams】
   * useSearchParams 在 app router 里会让整个页面进入客户端动态渲染，
   * Next 15 构建时会要求外面套一层 Suspense，否则 build 直接报错。
   * 这两个参数只影响交互、不影响首屏内容，读完再 setState 完全够用。
   */
  const [filter, setFilter] = useState<{ dim: Claim['dimension'] | null; type: Claim['type'] | null }>({
    dim: null,
    type: null,
  });
  const [reviseFrom, setReviseFrom] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const dim = sp.get('dim');
    const type = sp.get('type');
    const revise = sp.get('revise');
    const isDim = (v: string | null): v is Claim['dimension'] =>
      v === 'logic' || v === 'evidence' || v === 'depth' || v === 'expression';
    const isType = (v: string | null): v is Claim['type'] =>
      v === 'method' || v === 'engineering' || v === 'value';
    if (isDim(dim) || isType(type)) {
      setFilter({ dim: isDim(dim) ? dim : null, type: isType(type) ? type : null });
    }
    if (revise) setReviseFrom(revise);
  }, []);

  useEffect(() => {
    void params.then((p) => setDocId(p.id));
  }, [params]);

  const load = useCallback(async (id: string) => {
    const [d, c] = await Promise.all([
      fetch(`/api/docs`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/docs/${id}/claims`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    if (d.ok) {
      const found = (d.docs as Array<Doc & { id: string }>).find((x) => x.id === id);
      setDoc(found ?? null);
    }
    if (c.ok) setClaims(c.claims as Claim[]);
  }, []);

  useEffect(() => {
    if (docId) void load(docId);
  }, [docId, load]);

  const extract = useCallback(async () => {
    if (!docId) return;
    setBusy(true);
    setFail(null);
    try {
      const r = await fetch(`/api/docs/${docId}/claims`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        setFail({ code: j.code ?? 'E_UNKNOWN', message: j.message ?? '抽取失败。' });
        return;
      }
      setClaims(j.claims as Claim[]);
      setRate({ quote: j.quote, absence: j.absence });
      setCoverage(j.coverage ?? null);
    } catch {
      setFail({ code: 'E_NET', message: '网络中断，抽取失败。' });
    } finally {
      setBusy(false);
    }
  }, [docId]);

  /**
   * 开一场质询。
   *
   * 【为什么这个入口必须在阶段 5 补上】
   * 阶段 4 结束时，全仓库只有 scripts 里的探针脚本能调 POST /api/sessions ——
   * 也就是说 README 里写的「选材料 → 开始质询 → 出报告 → 复练」这条闭环，
   * 在界面上是断的。评委点进来会卡在这一步，验收「quick 全流程 ≤8 分钟」根本无从谈起。
   */
  const startSession = useCallback(
    async (mode: 'quick' | 'full' | 'revise') => {
      if (!docId) return;
      setStarting(mode);
      setStartErr(null);
      try {
        const body: Record<string, string> = { docId, mode };
        if (mode === 'revise' && reviseFrom) body.drillFrom = reviseFrom;
        const r = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
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
        setStarting(null);
      }
    },
    [docId, reviseFrom, router],
  );

  const quoteTotal = claims.filter((c) => c.locator_kind === 'quote').length;
  const quoteHit = claims.filter((c) => c.locator_kind === 'quote' && c.verified === 1).length;
  const absenceTotal = claims.filter((c) => c.locator_kind === 'absence').length;

  /**
   * 看板格子点进来时只显示那一格。
   * 没有筛选条件时原样显示全部——不改变默认视图。
   */
  const filtered = filter.dim !== null || filter.type !== null;
  const visible = !filtered
    ? claims
    : claims.filter(
        (c) =>
          (filter.dim === null || c.dimension === filter.dim) &&
          (filter.type === null || c.type === filter.type),
      );

  return (
    <>
      <div className="ribbon">
        <b>预演 · 质询台</b>
        <span>质疑点 · 材料风险图谱</span>
        <span style={{ marginLeft: 'auto' }}>{doc?.name ?? '材料'}</span>
      </div>

      <main className="shell">
        <div className="hero-badge">CHECKPOINT · 漏洞透视</div>
        <h1 className="wordmark">质疑点</h1>
        <p className="lede">
          每条质疑都带着一个锚点：<b>能引的，标出原文那一句并逐字机检</b>；
          <b>不能引的（比如“你缺对照组”），显式标成“缺失”并写明查过哪些章节</b>。
          后者不可点开——因为它本来就没有原文可点。
        </p>

        {doc && (
          <div className="stat">
            <span>
              材料 <b>{doc.name}</b>
            </span>
            <span>{doc.pages !== null ? `${doc.pages} 页` : 'FLOW 无页'}</span>
            <span>
              字符 <b>{doc.chars}</b>
            </span>
            <span>density <b>{doc.density}</b></span>
            <span>
              质疑点 <b>{claims.length}</b>
            </span>
            {quoteTotal > 0 && (
              <span>
                引用命中 <b className={quoteHit === quoteTotal ? 'hit' : 'miss'}>{quoteHit}/{quoteTotal}</b>
                {` = ${((quoteHit / quoteTotal) * 100).toFixed(0)}%`}
              </span>
            )}
            {absenceTotal > 0 && <span>缺失类 <b>{absenceTotal}</b>（不计入命中率）</span>}
          </div>
        )}

        {claims.length === 0 && (
          <div style={{ marginTop: 26 }}>
            <button className="btn" onClick={extract} disabled={busy || !docId}>
              {busy ? '正在抽取…' : '开始抽取质疑点'}
            </button>
          </div>
        )}

        {fail && (
          <div className="err">
            <span className="code">{fail.code}</span>
            {fail.message}
          </div>
        )}

        {claims.length > 0 && (
          <>
            {/* ── 开场入口：闭环的起点。没有它，后面所有页面都只是"只能看不能走" ── */}
            <section className="launch" aria-label="开始质询">
              <div className="launch-hd">
                <h2>开始质询</h2>
                <p>
                  三位评委会各挑一条最危险的质疑点发问
                  {reviseFrom ? '；这是「改后材料重审」，报告里会显示与上一场的风险分差和质疑点增删。' : '。'}
                </p>
              </div>
              <div className="launch-btns">
                <button className="btn" onClick={() => startSession('quick')} disabled={starting !== null}>
                  {starting === 'quick' ? '正在排席位…' : '开始质询 · quick（3 问出报告）'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => startSession('full')}
                  disabled={starting !== null}
                >
                  {starting === 'full' ? '正在排席位…' : '完整评审 · full（最多 15 轮）'}
                </button>
                {reviseFrom ? (
                  <button className="btn" onClick={() => startSession('revise')} disabled={starting !== null}>
                    {starting === 'revise' ? '正在排席位…' : '用改后材料重审 · revise'}
                  </button>
                ) : null}
              </div>
              <p className="launch-note">
                随时可以「结束并出报告」——报告不会因为提前结束而缺席。
              </p>
              {startErr ? (
                <div className="err">
                  <span className="code">E_START</span>
                  {startErr}
                </div>
              ) : null}
            </section>

            <div style={{ marginTop: 22, display: 'flex', gap: 12, alignItems: 'center' }}>
              <button className="btn" onClick={extract} disabled={busy}>
                {busy ? '正在重抽…' : '重新抽取'}
              </button>
              {rate.quote && (
                <span className="dimtag">
                  本次机检：引用 {rate.quote.hit}/{rate.quote.total}，缺失 {rate.absence?.total ?? 0}
                </span>
              )}
            </div>

            {/* 做了抽样就必须说，不许让报告看起来像"审了全部" */}
            {coverage?.sampled && (
              <div className="err" style={{ borderLeftColor: 'var(--line-2)', background: 'var(--paper-2)' }}>
                <span className="code" style={{ color: 'var(--muted)' }}>覆盖范围说明</span>
                这份材料共 {coverage.totalBatches} 个文本批次，受单场预算限制只审了其中{' '}
                <b>{coverage.sampledBatches}</b> 个（均匀覆盖开头到结尾），跳过了 {coverage.skippedBatches} 个。
                因此<b>未抽到的部分没有被质疑，不等于没有问题</b>。请把本页理解为抽样结果，而非全量体检。
              </div>
            )}

            {/* 从报告看板的某一格点进来：明说"只显示这一格"，并给一键退出 */}
            {filtered ? (
              <div className="filterbar">
                <span className="filter-bar-label">只看</span>
                {filter.dim ? (
                  <span className="dimtag" style={{ background: 'var(--paper-2)' }}>
                    <i style={{ background: DIM_COLOR[filter.dim], width: 6, height: 6, display: 'inline-block' }} />
                    {DIM_LABEL[filter.dim]}
                  </span>
                ) : null}
                {filter.type ? <span className="dimtag">{TYPE_LABEL[filter.type]}</span> : null}
                <b>{visible.length}</b> 条
                <button
                  className="toggle"
                  onClick={() => setFilter({ dim: null, type: null })}
                  style={{ marginLeft: 'auto' }}
                >
                  显示全部质疑点
                </button>
              </div>
            ) : null}

            <div className="cols">
              {(['method', 'engineering', 'value'] as const)
                .filter((tp) => filter.type === null || filter.type === tp)
                .map((tp) => {
                const list = visible.filter((c) => c.type === tp);
                return (
                  <section className="col" key={tp}>
                    <div className="colhd">
                      <i style={{ background: DIM_COLOR[list[0]?.dimension ?? 'logic'] }} />
                      <span className="nm">{TYPE_LABEL[tp]}</span>
                      <span className="n">{list.length}</span>
                    </div>
                    {list.length === 0 && <p className="empty">— 无 —</p>}
                    {list.map((c) => {
                      const isAbsence = c.locator_kind === 'absence';
                      const opened = open[c.block_idx] === true;
                      return (
                        <article
                          className={`card ${isAbsence ? 'absence-line' : 'quote-line'}`}
                          key={`${c.block_idx}-${c.text.slice(0, 8)}`}
                        >
                          <div className="body">
                            <p className="txt">{c.text}</p>

                            <div className="meta">
                              <span className="stars">
                                {Array.from({ length: 5 }, (_, i) => (
                                  <span key={i} className={i < c.risk ? 'on' : 'off'}>
                                    ★
                                  </span>
                                ))}
                              </span>
                              <span className="dimtag">
                                <i style={{ background: DIM_COLOR[c.dimension], width: 6, height: 6, display: 'inline-block' }} />
                                {DIM_LABEL[c.dimension]}
                              </span>
                            </div>

                            {isAbsence ? (
                              // absence：不可点开。没有原文可点，就不能给出"可点开"的暗示
                              <span className="anchor absence">
                                缺失 · 已检索 {c.scope ?? '未标注范围'}
                              </span>
                            ) : (
                              <>
                                <span className="anchor">
                                  {c.page !== null ? `P${c.page}` : c.section ?? '无章节'} · BLOCK {c.block_idx}
                                  {c.verified === 1 ? ' · ✓ 逐字命中' : ' · 未校验'}
                                </span>
                                <br />
                                <button
                                  className="toggle"
                                  onClick={() => setOpen((s) => ({ ...s, [c.block_idx]: !s[c.block_idx] }))}
                                >
                                  {opened ? '收起原文' : '展开原文'}
                                </button>
                                {opened && (
                                  <div className="src">
                                    <span className="where">
                                      {c.page !== null ? `P${c.page}` : c.section ?? '无章节'} · BLOCK {c.block_idx}
                                      {' · '}朱红高亮处即被引用的逐字原文
                                    </span>
                                    <Highlighted source={c.source ?? c.quote} quote={c.quote} />
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </main>
    </>
  );
}
