// app/api/sessions/route.ts —— 创建质询会话（POST）与列表（GET）
//
// 【本路由最重要的一件事】首问必须落在一条**已存在的 claim** 上。
// 这是与"自由协作 Agent 群"划清界线的地方：问题没有 claim 锚点 → 无法溯源 → 整个创新点失效。
// 所以模型返回的 claim_id 一律要过一遍存在性校验，对不上就丢弃换人，绝不"反正问出来了就用"。

import { q, tx } from '@/lib/db';
import { callLLM } from '@/lib/llm';
import {
  PERSONAS_SYSTEM,
  buildPersonasUser,
  PersonasSchema,
  DIM_COLOR,
  type ClaimForPersona,
} from '@/lib/prompts/personas.v1';
import { MODE_MATRIX, type SessionMode } from '@/lib/state';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type PersonaRow = {
  id: string;
  name: string;
  role: string;
  focus: string;
  tone: string;
  color: string;
};

export async function GET() {
  const rows = q.all(
    `select s.id, s.doc_id, s.mode, s.state, s.started_at, d.name as doc_name
     from sessions s left join documents d on d.id = s.doc_id
     order by s.started_at desc limit 20`,
  );
  return Response.json({ ok: true, sessions: rows });
}

function loadClaims(docId: string): ClaimForPersona[] {
  const rows = q.all(
    `select id, type, text, dimension, risk, page, section, quote, locator_kind, verified
     from claims where doc_id = ? order by risk desc`,
    docId,
  );
  return rows.map((r) => ({
    id: String(r.id),
    type: String(r.type) as ClaimForPersona['type'],
    text: String(r.text),
    dimension: String(r.dimension) as ClaimForPersona['dimension'],
    risk: Number(r.risk),
    page: r.page === null ? null : Number(r.page),
    section: r.section === null ? null : String(r.section),
    quote: String(r.quote ?? ''),
    locatorKind: String(r.locator_kind) as ClaimForPersona['locatorKind'],
    verified: r.verified === null ? null : (Number(r.verified) as 0 | 1),
  }));
}

export async function POST(req: Request) {
  try {
    return await handleCreate(req);
  } catch (e) {
    console.error('[POST /api/sessions]', e);
    return Response.json(
      { ok: false, code: 'E_INTERNAL', message: '创建会话时出现意外错误，请重试。' },
      { status: 500 },
    );
  }
}

async function handleCreate(req: Request): Promise<Response> {
  let body: { docId?: string; mode?: SessionMode; drillFrom?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, code: 'E_FORM', message: '请求体必须是 JSON。' }, { status: 400 });
  }

  const docId = body.docId;
  if (!docId) {
    return Response.json({ ok: false, code: 'E_NO_DOC', message: '缺少 docId。' }, { status: 400 });
  }

  const mode: SessionMode = body.mode ?? 'quick'; // quick 是默认档（C11）
  if (!(mode in MODE_MATRIX)) {
    return Response.json(
      { ok: false, code: 'E_MODE', message: `不支持的档位：${mode}。` },
      { status: 400 },
    );
  }

  const doc = q.get('select id, name from documents where id = ?', docId);
  if (!doc) {
    return Response.json({ ok: false, code: 'E_NO_DOC', message: '找不到这份材料。' }, { status: 404 });
  }

  const claims = loadClaims(docId);
  if (claims.length === 0) {
    return Response.json(
      {
        ok: false,
        code: 'E_NO_CLAIMS',
        message: '这份材料还没有抽取质疑点。请先在质疑点页面抽取一次。',
      },
      { status: 409 },
    );
  }

  // 人设由模型生成，但 **color 由服务端按维度分配**（不让模型决定视觉）
  let out;
  try {
    out = await callLLM({
      sessionKey: `personas:${docId}`,
      phase: 'personas',
      system: PERSONAS_SYSTEM,
      user: buildPersonasUser(claims),
      schema: PersonasSchema,
      temperature: 0.3,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return Response.json(
      { ok: false, code: err.code ?? 'E_LLM', message: err.message ?? '生成评委失败。' },
      { status: 502 },
    );
  }

  const personasOut = (out.data as {
    personas: Array<{
      name: string;
      role: string;
      focus: string;
      tone: string;
      color: string;
      opening: Array<{ claim_id: string; question: string }>;
    }>;
  }).personas;

  // claim_id 存在性校验：模型编的 id 一律丢弃
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const validated = personasOut
    .map((p) => {
      const openings = p.opening.filter((o) => claimById.has(o.claim_id));
      return { ...p, opening: openings };
    })
    .filter((p) => p.opening.length > 0);

  if (validated.length === 0) {
    // 全部 opening 都对不上 → 这是明确的失败，不能"凑一个"糊过去
    return Response.json(
      {
        ok: false,
        code: 'E_NO_ANCHOR',
        message: '生成的评委会问题没能对上任何一条已抽取的质疑点（锚点校验失败）。请重试一次。',
      },
      { status: 502 },
    );
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const matrix = MODE_MATRIX[mode];

  const personaRows: PersonaRow[] = [];
  tx(() => {
    q.run(
      `insert into sessions(id, doc_id, mode, drill_from, state, started_at, ended_at)
       values(?,?,?,?,?,?,?)`,
      sessionId,
      docId,
      mode,
      body.drillFrom ?? null,
      'PERSONAS_READY',
      now,
      null,
    );

    for (const p of validated.slice(0, matrix.judges)) {
      const pid = crypto.randomUUID();
      // color 由服务端按该评委负责类型的首个候选 claim 的维度分配
      const firstClaim = claimById.get(p.opening[0].claim_id);
      const dim = firstClaim?.dimension ?? 'logic';
      const row: PersonaRow = {
        id: pid,
        name: p.name,
        role: p.role,
        focus: p.focus,
        tone: p.tone,
        color: DIM_COLOR[dim],
      };
      personaRows.push(row);
      q.run(
        `insert into personas(id, doc_id, name, role, focus, tone, color, created_at)
         values(?,?,?,?,?,?,?,?)`,
        pid,
        docId,
        row.name,
        row.role,
        row.focus,
        row.tone,
        row.color,
        now,
      );
    }
  });

  // 第一位评委 + 首问
  const first = personaRows[0];
  const firstOpening = validated[0].opening[0];
  const firstClaim = claimById.get(firstOpening.claim_id)!;

  return Response.json({
    ok: true,
    sessionId,
    mode,
    modeLabel: matrix.label,
    maxTurns: matrix.maxTurns,
    judges: personaRows.length,
    personas: personaRows.map((p) => ({ id: p.id, name: p.name, role: p.role, focus: p.focus, tone: p.tone, color: p.color })),
    question: {
      personaId: first.id,
      personaName: first.name,
      question: firstOpening.question,
      claimId: firstClaim.id,
      // 带着锚点出发：聊天页的"扫读原文思考态"要用它
      anchor: {
        blockIdx: null, // 由 turns 表或 claims 查得，聊天页按 claimId 展开
        claimId: firstClaim.id,
        page: firstClaim.page,
        section: firstClaim.section,
        quote: firstClaim.quote,
        locatorKind: firstClaim.locatorKind,
        verified: firstClaim.verified,
      },
    },
  });
}
