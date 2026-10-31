// app/api/sessions/[id]/stream/route.ts —— SSE 流式出题（C4，P0）
//
// 【这个路由的职责边界】
// 只做三件事：① 解析入参 → ② 调 lib/session.ts 算出"现在轮到谁、锚点在哪"
// → ③ 调 lib/llm.ts 流式出题并用 lib/sse.ts 编码成 SSE 事件。
// 任何业务判断（谁该问、问几问、什么时候结束）都在 lib/ 里（§3.6 路由层禁令）。
//
// 【为什么首字节必须立刻发】
// "首字到达 < 1.5s" 是 DoD 硬指标，也是体验 15% 里"如流式"的证据。
// 但真实模型冷启动 + 排队常常 >1s。所以响应一开始就发一条注释行 `: ready`，
// 让**连接建立 + 浏览器开始解析**这件事立刻可观测，随后 meta 事件立刻跟上，
// token 事件随模型出字即时推送。这样"首字节"几乎瞬时，"首字"取决于模型但被降到最低。
//
// 【60s 硬断（S6）】
// 用 AbortController + 定时器：到点先发 error(timeout)，再关流。
// 不这样做的话，一个卡住的上游会让连接挂到平台超时，用户看到的是"转圈到死"。

import {
  encodeEvent,
  encodeComment,
  errorToSse,
  metaFromCall,
  createFieldStreamer,
  SSE_HARD_TIMEOUT_MS,
  TOKEN_FLUSH_CHARS,
} from '@/lib/sse';
import { callLLMStream, LlmError } from '@/lib/llm';
import { loadSession, loadPersonas, currentQuestion, progressOf, loadAnchor } from '@/lib/session';
import { QUESTION_SYSTEM, buildQuestionUser, QuestionSchema, dimLabelOf } from '@/lib/prompts/question.v1';
import { MODE_MATRIX } from '@/lib/state';
import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function sse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-cache 必须带，否则某些代理会缓存整条流
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉 nginx 一类中间层的缓冲，否则 token 会攒成一大块才到前端
      'x-accel-buffering': 'no',
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const session = loadSession(id);
  if (!session) {
    // 404 也走 SSE 格式，前端只需一套解析逻辑
    return sse(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(encodeEvent('error', { code: 'internal', fallback: '找不到这场会话。' })));
          c.close();
        },
      }),
    );
  }

  const encoder = new TextEncoder();
  const controller = new AbortController();
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(stream) {
      const push = (text: string) => {
        if (closed) return;
        try {
          stream.enqueue(encoder.encode(text));
        } catch {
          closed = true; // 客户端已断开，enqueue 会抛
        }
      };

      // 立刻发首字节 + 心跳，让浏览器马上进入解析状态
      push(encodeComment('ready'));

      const timer = setTimeout(() => {
        if (closed) return;
        push(encodeEvent('error', errorToSse('E_TIMEOUT')));
        closed = true;
        controller.abort();
        try {
          stream.close();
        } catch {
          /* 已关闭 */
        }
      }, SSE_HARD_TIMEOUT_MS);

      // 客户端刷新/关页面 → abort 上游，不留孤儿请求（S6）
      req.signal.addEventListener('abort', () => {
        controller.abort();
        closed = true;
        clearTimeout(timer);
      });

      try {
        const matrix = MODE_MATRIX[session.mode] ?? MODE_MATRIX.quick;
        const personas = loadPersonas(session.id, session.docId, matrix.judges);

        if (personas.length === 0) {
          push(encodeEvent('error', { code: 'internal', fallback: '这场会话没有评委，请重新创建。' }));
          clearTimeout(timer);
          stream.close();
          return;
        }

        // 先纠正 progress 的 personaIndex：它按 answered 取模，与这里实际选的人必须一致
        const cur = currentQuestion(session);
        const progress = progressOf(session);

        // 已结束的会话：直接 done，不再生成新问题（结束权在代码不在模型）
        if (!cur) {
          push(
            encodeEvent('done', {
              turnId: null,
              state: session.state,
              progress,
              message: '本场已结束。可以出报告了。',
            }),
          );
          clearTimeout(timer);
          stream.close();
          return;
        }

        const persona = cur.persona;

        // 若这一问题已经在 turns 里生成过（例如前端断线重连），直接重播，不重复烧预算
        if (cur.claimId && cur.anchor) {
          push(
            encodeEvent('meta', {
              persona: persona.name,
              personaId: persona.id,
              qIndex: progress.qIndex,
              qTotal: progress.qTotal,
              claimId: cur.claimId,
              blockIdx: cur.anchor.blockIdx,
              source: cur.anchor.source,
              page: cur.anchor.page,
              section: cur.anchor.section,
              locatorKind: cur.anchor.locatorKind,
              verified: cur.anchor.verified,
              replay: true,
            }),
          );
          // 重播不走模型：把库里存的 question 逐段吐出，保证与首次一致且零成本。
          // 条件与 lib/session.ts 的 currentQuestion 保持一致：
          // 必须「问题已生成、用户未答」，否则会把一条半成品 turn 的空字符串重播成一片空白。
          const pending = q.get(
            `select id, question from turns
             where session_id = ? and (answer is null or answer = '')
               and question is not null and question != ''
             order by seq limit 1`,
            session.id,
          );
          const text = pending ? String(pending.question) : '';
          for (let i = 0; i < text.length; i += TOKEN_FLUSH_CHARS) {
            push(encodeEvent('token', { t: text.slice(i, i + TOKEN_FLUSH_CHARS) }));
          }
          push(encodeEvent('done', { turnId: pending ? String(pending.id) : null, state: session.state, progress }));
          clearTimeout(timer);
          stream.close();
          return;
        }

        // 全新的一问：先选锚点，再流式出题。
        // 候选池 = 这份材料里本场还没问过的 claim（全局去重 §3.8 附加规则：
        // 同一 claim 一场内不可被重复 targeting，否则三位评委容易围着同一个点各问一遍）。
        const askedIds = (q.all(
          `select target_claim_id from turns where session_id = ? and target_claim_id is not null`,
          session.id,
        ) as Array<Record<string, unknown>>).map((r) => String(r.target_claim_id));

        const candidates = (q.all(
          `select id, type, text, dimension, risk, page, section, quote, locator_kind, verified
           from claims where doc_id = ? order by risk desc`,
          session.docId,
        ) as Array<Record<string, unknown>>).filter((r) => !askedIds.includes(String(r.id)));

        if (candidates.length === 0) {
          // 没有可问的了：这一场该结束（报告永不缺席，C11）
          push(
            encodeEvent('done', {
              turnId: null,
              state: 'ENDED',
              progress,
              message: '材料里的质疑点都已问过，可以出报告了。',
            }),
          );
          clearTimeout(timer);
          stream.close();
          return;
        }

        // 优先取该评委负责的质疑类型；没有再退一步取任意类型（但锚点必须真实存在）
        const pick =
          candidates.find((r) => r.type === persona.role) ?? candidates[0];

        const claimId = String(pick.id);
        const anchor = loadAnchor(claimId);
        if (!anchor) {
          push(encodeEvent('error', { code: 'internal', fallback: '引用的原文找不到，请重新抽取质疑点。' }));
          clearTimeout(timer);
          stream.close();
          return;
        }

        // meta 先于 token，前端才能立刻渲染"评委正在读这几行原文"
        push(
          encodeEvent('meta', {
            persona: persona.name,
            personaId: persona.id,
            qIndex: progress.qIndex,
            qTotal: progress.qTotal,
            claimId,
            blockIdx: anchor.blockIdx,
            source: anchor.source,
            page: anchor.page,
            section: anchor.section,
            locatorKind: anchor.locatorKind,
            verified: anchor.verified,
          }),
        );

        // 落一条 turn 占位（answer 为空），让重连与 /answer 都能找到这一问。
        // 【列数与值数必须逐一对齐】这里踩过一次：列清单是 10 列而只传了 9 个值，
        // SQLite 会把后面的值整体左移一格——结果 answer 里装进了 claim id、
        // target_claim_id 里装进了时间戳。库里看起来"有数据"，但每个字段都在错的位置上，
        // 而且不会报错。任何给这张表加列的改动，都要同时检查这里与列清单。
        const turnId = crypto.randomUUID();
        const seq = progress.answered + 1;
        q.run(
          `insert into turns(id, session_id, persona_id, seq, round, kind, question, answer, target_claim_id, created_at)
           values(?,?,?,?,?,?,?,?,?,?)`,
          turnId,                    // id
          session.id,                // session_id
          persona.id,                // persona_id
          seq,                       // seq
          Math.ceil(seq / matrix.judges), // round
          'question',                // kind
          '',                        // question（流式产出中先空着，done 时补写）
          '',                        // answer（用户还没答，空串比 null 好查询）
          claimId,                   // target_claim_id
          new Date().toISOString(),  // created_at
        );

        // 显式迭代而不是 for await，原因：generator 的 return 值（校验后的对象）
        // 只有通过迭代器结果的 done/value 才拿得到；for await 会把它丢掉。
        let buffered = '';
        let full = '';
        let streamed = ''; // 解包器已吐给前端的可见文本（用于最终写库兜底）
        let finalData: unknown = null;
        let finalMeta: ReturnType<typeof metaFromCall> | undefined;
        let iterDone = false;
        const fieldStreamer = createFieldStreamer('question');

        const gen = callLLMStream({
          sessionKey: session.id,
          phase: 'evaluate',
          system: QUESTION_SYSTEM,
          user: buildQuestionUser({
            persona: { name: persona.name, role: persona.role, tone: persona.tone, focus: persona.focus },
            dimLabel: dimLabelOf(String(pick.dimension)),
            claim: {
              id: claimId,
              type: String(pick.type),
              text: String(pick.text),
              risk: Number(pick.risk),
              section: pick.section === null ? null : String(pick.section),
              page: pick.page === null ? null : Number(pick.page),
              quote: String(pick.quote ?? ''),
              locatorKind: String(pick.locator_kind) as 'quote' | 'absence',
              verified: pick.verified === null ? null : (Number(pick.verified) as 0 | 1),
            },
            source: anchor.source,
            qIndex: progress.qIndex,
            qTotal: progress.qTotal,
            docName: String(q.get(`select name from documents where id = ?`, session.docId)?.name ?? '材料'),
          }),
          schema: QuestionSchema,
          temperature: 0.4,
          signal: controller.signal,
        });

        while (!iterDone && !closed) {
          const step = await gen.next();
          if (step.done) {
            iterDone = true;
            finalData = step.value?.data ?? null;
            finalMeta = step.value?.meta ? metaFromCall(step.value.meta) : undefined;
            break;
          }
          const delta = step.value;
          full += delta;

          // 【关键一步：解包 JSON 外壳】
          // 上游开着 response_format: json_object，增量形如 `{"question": "这三所`。
          // 必须只把 "question" 字段的**值**推给前端，否则聊天页会逐字显示
          // `{"question": "` 和结尾的 `"}`，把"评委在说话"演成"在看一段代码"。
          const visible = fieldStreamer.push(delta);
          if (!visible) continue;

          streamed += visible;
          buffered += visible;
          // 按字符数节流：太碎会让浏览器每秒接收上百个事件，大段反而没有"出字"的手感
          if (buffered.length >= TOKEN_FLUSH_CHARS) {
            push(encodeEvent('token', { t: buffered }));
            buffered = '';
          }
        }
        if (buffered) push(encodeEvent('token', { t: buffered }));

        // 校验后的最终问题写回 turns（流式原文里带 JSON 外壳，用户看到的是解包后的那句话）
        const finalQuestion =
          String((finalData as { question?: string } | null)?.question ?? '').trim() ||
          // 万一 zod 那步没走到（例如被 abort），用解包器已经吐出的文本兜底，
          // 绝不要回落到 `full`（那是带 JSON 外壳的原始串）
          streamed.trim();
        q.run(`update turns set question = ? where id = ?`, finalQuestion, turnId);

        push(
          encodeEvent('done', {
            turnId,
            state: 'ASKING',
            progress,
            meta: finalMeta,
          }),
        );

        clearTimeout(timer);
        stream.close();
      } catch (e) {
        const err = e as LlmError | Error;
        const code = (err as LlmError).code ?? 'E_INTERNAL';
        // 【必须留服务端日志】SSE 只能给前端一句 fallback，真正的堆栈只有这里看得到。
        // 阶段 3 第一次真实跑这个路由时，正是因为漏了这行，前端只收到"内部错误"，
        // 排查时无从下手（错误信息没有进入任何可读的地方）。
        console.error('[GET /api/sessions/:id/stream]', code, err);
        push(encodeEvent('error', errorToSse(code, err.message)));
        clearTimeout(timer);
        try {
          stream.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel() {
      // 客户端断开
      closed = true;
      controller.abort();
    },
  });

  return sse(body);
}
