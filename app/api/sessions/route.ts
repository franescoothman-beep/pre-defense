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
  planSeats,
  seatClaimIds,
  PersonasSchema,
  DIM_COLOR,
  DIM_LABEL,
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
  /** 这位评委盯哪个面（决定横条标签色，也是报告左栏按维度聚合的依据） */
  dimension: 'logic' | 'evidence' | 'depth' | 'expression';
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
    `select id, type, text, dimension, risk, block_idx, page, section, quote, locator_kind, verified
     from claims where doc_id = ? order by risk desc`,
    docId,
  );
  return rows.map((r) => ({
    id: String(r.id),
    type: String(r.type) as ClaimForPersona['type'],
    text: String(r.text),
    dimension: String(r.dimension) as ClaimForPersona['dimension'],
    risk: Number(r.risk),
    blockIdx: Number(r.block_idx),
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

  const matrix = MODE_MATRIX[mode];

  // 席位由服务端按材料真实分布排定；模型只负责"给每个席位一个名字与首问"
  const seats = planSeats(claims, matrix.judges);
  if (seats.length === 0) {
    return Response.json(
      {
        ok: false,
        code: 'E_NO_SEAT',
        message: '这份材料的质疑点分布无法排出任何评委席位，请重新抽取质疑点。',
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
      user: buildPersonasUser(claims, matrix.judges),
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
      opening: Array<{ claim_id: string; question: string }>;
    }>;
  }).personas;

  const claimById = new Map(claims.map((c) => [c.id, c]));

  // 【锚点归属校验，比"存在性"更严】
  // 只校验 claim_id 在库里存在是不够的：模型会"借用"别的席位的 claim，
  // 结果一位 engineering 评委拿着 method 的质疑点开问（串味，DoD 第 1 条直接不达标）。
  // 所以按席位一一对应：第 i 位评委的 opening 只能落在第 i 席的候选清单里。
  // 席位不足时（模型少给或多给），按索引对齐，多余的直接丢弃。
  const validated = personasOut
    .slice(0, seats.length)
    .map((p, i) => {
      const allowed = seatClaimIds(seats[i]);
      const openings = p.opening.filter((o) => allowed.has(o.claim_id) && claimById.has(o.claim_id));
      return { ...p, seat: seats[i], opening: openings };
    })
    .filter((p) => p.opening.length > 0);

  if (validated.length < seats.length) {
    // 席位没填满：说明模型没守住"只能从自己清单里选"，这是可解释的失败
    console.warn(
      `[POST /api/sessions] 席位未填满：期望 ${seats.length} 位，通过锚点归属校验的只有 ${validated.length} 位。`,
    );
  }

  if (validated.length === 0) {
    // 全部 opening 都对不上 → 这是明确的失败，不能"凑一个"糊过去
    return Response.json(
      {
        ok: false,
        code: 'E_NO_ANCHOR',
        message: '生成的评委会问题没能对上任何一条属于自己的质疑点（锚点归属校验失败）。请重试一次。',
      },
      { status: 502 },
    );
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  const personaRows: PersonaRow[] = [];
  tx(() => {
    // 【必须先清掉这位材料上一轮的人设】
    // personas 是按 doc_id 存的。若不清，用户在同一份材料上开第二场会话时，
    // 表里会有 3+3=6 条、第三场 9 条……而 lib/session.ts 取"当前第几位评委"是按
    // 这份材料的 personas 列表取模的 —— 多出来的旧人设会让评委轮转彻底错位
    // （表现为"第 2 问还是第一位评委在问"）。人设属于"当前这一场"，不属于材料。
    q.run(`delete from personas where doc_id = ?`, docId);

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

    for (const p of validated) {
      const pid = crypto.randomUUID();
      // role 与 color 都取自**服务端排定的席位**，不采信模型自己写的 role：
      // 席位的维度决定了这位评委该问哪个面，颜色必须与那一面绑定（§3.2「颜色只编码数据」）。
      // 若这里改用模型给的 role，就会出现"穿藕荷色衣服却在问逻辑链"的错位。
      const row: PersonaRow = {
        id: pid,
        name: p.name,
        role: p.seat.type,
        focus: p.focus,
        tone: p.tone,
        color: DIM_COLOR[p.seat.dim],
        dimension: p.seat.dim,
      };
      personaRows.push(row);
      q.run(
        `insert into personas(id, doc_id, name, role, focus, tone, color, dimension, session_id, created_at)
         values(?,?,?,?,?,?,?,?,?,?)`,
        pid,
        docId,
        row.name,
        row.role,
        row.focus,
        row.tone,
        row.color,
        p.seat.dim,   // dimension：排席位时就定了，存下来供读取侧直接用
        sessionId,
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
    // 【同时返回 dimension 与 color】前端横条要用 dimension 选四维传统色标签。
    // 只给 color 的话，前端得把 #7c6a8a 反查回 "evidence" —— 那等于在展示层复制一份配色映射，
    // 以后调色一改就错位。dimension 本来就是排席位时定下来的，直接给出去最省事也最不会错。
    personas: personaRows.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      focus: p.focus,
      tone: p.tone,
      color: p.color,
      // dimension 从 row 直接带出：seat 与 persona 在 validated 过滤后可能错位，
      // 用 row.dimension 才能保证"标签色"与"存库的那一面"是同一个值
      dimension: p.dimension,
    })),
    // 【如实报覆盖】不假装材料有它没有的维度。
    // 报告左栏 risk_score 按维度聚合，没有 claim 的维度会显示"未覆盖"（不填 0、不填均值）。
    // 这里把"哪几维真的排上了席位、哪几维材料本身就没有"提前告诉前端，UI 才能诚实标注。
    coverage: {
      dimension: DIM_LABEL,
      seated: seats.map((s) => ({ dimension: s.dim, label: DIM_LABEL[s.dim], type: s.type, claims: s.candidates.length })),
      absent: (['logic', 'evidence', 'depth', 'expression'] as const).filter(
        (d) => !seats.some((s) => s.dim === d),
      ),
    },
    question: {
      personaId: first.id,
      personaName: first.name,
      question: firstOpening.question,
      claimId: firstClaim.id,
      // 带着锚点出发：聊天页的"扫读原文思考态"要用它
      anchor: {
        // 【不能给 null】这是 L5「扫读原文思考态」定位 block 的唯一依据：
        // 前端拿 blockIdx 去 blocks 表取那两行原文，才能显示"评委正在读的那句话"。
        // 给 null 就等于把这个全场唯一的不可替代状态机砍掉，UI 只能退化成一句空泛的"思考中"。
        blockIdx: firstClaim.blockIdx,
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
