// lib/llm.ts —— 唯一的 LLM 出口（OpenAI 兼容 + zod 校验 + 重试 + 预算 + 日志 + mock 分支）
//
// 设计要点（每一条都对应一个已经踩过或预见的坑）：
//
// 1) **zod 校验在这里做，不在调用方**。调用方永远拿到一个类型安全的对象或一个异常，
//    不会拿到"半对半错"的 JSON。这是 CLAUDE.md 铁律 3 的落点。
//
// 2) **失败只重试 1 次**，重试时把上次的报错信息拼进 prompt。
//    不无限重试的原因不是省钱，而是"模型连续两次给不出合法结构，第三次大概率还是给不出"，
//    无限重试会让一场会话的延迟失控（S6 要求 30s 超时、预算 ≤30 次）。
//
// 3) **MOCK_LLM 分支与真实分支走完全同一套校验**。mock 若绕过 zod，
//    就会在评委机器上静默通过一个真实模式会失败的响应 —— 那等于复现是假的。
//
// 4) **llm_logs 只存 prompt 的 hash**，绝不存正文（S4：材料与密钥不落库）。
//
// 5) **预算计数在进程内**：一场会话最多 30 次（S6）。超出直接抛 BudgetExceeded，
//    由路由层转成可读错误——比让模型跑到一半被平台限流好得多。

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { readUpstream } from './sse';
import { HARD_LIMITS } from './state';

/**
 * 四种阶段 + 一个提问阶段。
 *
 * 【为什么 `question` 必须单列，不能复用 `evaluate`】
 * `evaluate` 是"判分 + 追问"（阶段 4），`question` 是"把某条质疑点展开成一句提问"。
 * 两者若共用同一个 phase 键，mock 的回放游标会互相污染：
 * 第 1 问会去取 evaluate 的第 1 条，而那条根本还没录 —— 表现为 E_MOCK_MISS（真实踩过）。
 * 一个 phase 一个游标，是"序号驱动回放"能自洽的前提。
 */
export type Phase = 'claims' | 'personas' | 'question' | 'evaluate' | 'report';

/** S6：单场预算上限 */
export const MAX_CALLS_PER_SESSION = 30;
/** S6：单次调用超时 */
export const CALL_TIMEOUT_MS = 30_000;

export class LlmError extends Error {
  code:
    | 'E_NO_KEY'
    | 'E_TIMEOUT'
    | 'E_HTTP'
    | 'E_BAD_JSON'
    | 'E_SCHEMA'
    | 'E_BUDGET'
    | 'E_MOCK_MISS';
  /** 重试之后仍然失败时，附带最后一次的原始文本，便于 ai-log 定位 */
  raw?: string;
  constructor(code: LlmError['code'], message: string, raw?: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.raw = raw;
  }
}

export type CallMeta = {
  phase: Phase;
  model: string;
  promptHash: string;
  tokens: number;
  latencyMs: number;
  /** 是否走了 mock 回放；UI 的 MOCK 角标据此显示 */
  mock: boolean;
  attempts: number;
};

/** 进程内预算：key 是会话 id，值是已用次数 */
const budget = new Map<string, number>();

/**
 * 进程内并发闸（S6：并发 ≤2）。
 *
 * 【为什么必须有它】预算只数"调了几次"，挡不住"同时在调几次"。
 * 实测场景：用户在聊天页连点两次「提交」，或开两个标签页刷新重连，
 * 服务端会同时起两条流 —— 上游限流时两条都会超时，用户两条都收不到；
 * 而账单是双份的。并发闸是第一道也是唯一一道能在这个进程内生效的闸。
 *
 * 【为什么是 2 而不是 1】一条流在出字时，另一条"重新出题"是正常操作
 * （用户切换档位/重连），把它们串成绝对单飞会让体验明显变慢。
 * 2 是"允许一个正常并行"的最小值。
 */
const inflight = new Map<string, number>();

/**
 * S6 并发闸（≤2）的拒绝。
 *
 * 它**不是** LlmError：语义上"没调用成功"和"根本没开始调"是两件事，
 * 混在一个类型里会让上层把"上一条还在出字"当成"模型挂了"去降级。
 */
export class ConcurrencyError extends Error {
  code = 'E_CONCURRENCY' as const;
  /** 上限值带出来，前端文案与日志都不用再硬编码一遍 2 */
  limit: number;
  constructor(limit: number) {
    super(`本场同时进行的模型调用已达上限 ${limit} 次，请等当前这条回答结束。`);
    this.name = 'ConcurrencyError';
    this.limit = limit;
  }
}

/** 占一个并发位；调用方必须在 finally 里 release */
function acquire(sessionKey: string): void {
  const n = inflight.get(sessionKey) ?? 0;
  if (n >= HARD_LIMITS.maxConcurrentCalls) throw new ConcurrencyError(HARD_LIMITS.maxConcurrentCalls);
  inflight.set(sessionKey, n + 1);
}

function release(sessionKey: string): void {
  const n = inflight.get(sessionKey) ?? 0;
  if (n <= 1) inflight.delete(sessionKey);
  else inflight.set(sessionKey, n - 1);
}

/** 当前占用的并发位（测试与 health 自检用） */
export function inflightOf(sessionKey: string): number {
  return inflight.get(sessionKey) ?? 0;
}

/** 测试用：清零并发计数（真实场景不该调用） */
export function resetInflight(): void {
  inflight.clear();
}

export function budgetLeft(sessionId: string): number {
  return MAX_CALLS_PER_SESSION - (budget.get(sessionId) ?? 0);
}

export function resetBudget(sessionId: string): void {
  budget.delete(sessionId);
}

/** 只存 hash 不存正文（S4） */
export function promptHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function isMock(): boolean {
  return process.env.MOCK_LLM === '1';
}

/**
 * 原始响应落盘（只在 `LLM_CAPTURE=1` 时开启）。
 *
 * 【为什么需要在产品代码里加这个钩子】
 * 录制回放剧本（fixtures/llm/*.json）要的不是"模型大概说了什么"，而是
 * **通过 schema 校验之后的那个对象本身**。若在录制脚本里另写一套 fetch + 解析，
 * 就等于把 lib/llm.ts 里的重试、extractJson 三段容错、zod 校验全部复制一遍——
 * 复制出来的那份一定会在某次改 schema 后悄悄跑偏。
 * 所以钩子挂在唯一的出口上：抓到的必然与线上跑的是同一份数据。
 *
 * 【为什么不落库】S4 规定材料与密钥不落库；抓来的原文里既有 prompt（含材料片段）
 * 又有模型输出。写到 gitignore 覆盖的 `logs/` 下，用完即弃，不进库、不进报告。
 */
function capture(input: CallInput, data: unknown, meta: CallMeta): void {
  if (process.env.LLM_CAPTURE !== '1') return;
  try {
    const dir = path.join(process.cwd(), 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, 'llm-capture.jsonl'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        phase: input.phase,
        sessionKey: input.sessionKey,
        promptHash: meta.promptHash,
        attempt: meta.attempts,
        temperature: input.temperature ?? 0.2,
        // prompt 原文只在这里留一份，用于 prompt-eval 的同输入对照（v1 vs v2 必须同输入）
        system: input.system,
        user: input.user,
        response: data,
      })}\n`,
      'utf8',
    );
  } catch {
    // 抓取失败不能影响主流程
  }
}

/**
 * 从模型返回的文本里抽出 JSON。
 *
 * 真实模型经常干这三件事，都必须容错，否则整批数据报废：
 *   ① 用 ```json 包起来；② 前后带一句"好的，以下是……"；③ 直接给裸 JSON。
 * 注意：**不做"尽力修补"**（比如补引号、补括号）——那会把错误藏起来，
 * 让一个本该重试的失败变成一个悄悄错掉的对象。
 */
export function extractJson(text: string): unknown {
  const t = text.trim();

  // ① 去掉 ```json ... ``` 包裹
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fence ? fence[1].trim() : t;

  try {
    return JSON.parse(body);
  } catch {
    /* 继续尝试定位第一个完整 JSON 值 */
  }

  // ② 从第一个 { 或 [ 开始做括号配平，找到最外层完整值
  const start = body.search(/[{[]/);
  if (start >= 0) {
    const open = body[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(body.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

type CallInput = {
  /** 会话 id：预算按会话计。mock 回放也用同一 key 做游标 */
  sessionKey: string;
  phase: Phase;
  /** 系统提示（含规则），会被 hash 但不入日志正文 */
  system: string;
  /** 用户消息（含材料片段） */
  user: string;
  schema: ZodType;
  /** 温度；判定类任务用低温 */
  temperature?: number;
  /**
   * 取消信号（流式专用）。客户端断开 SSE 连接时，路由拿它的 signal 传进来，
   * 让这里能直接掐掉上游请求——否则上游会继续跑满 30s 超时并继续消耗预算。
   */
  signal?: AbortSignal;
};

/** 真实调用：OpenAI 兼容接口 */
async function callReal(input: CallInput): Promise<{ data: unknown; meta: CallMeta }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new LlmError(
      'E_NO_KEY',
      '未配置 DEEPSEEK_API_KEY。若只是想复现演示，请把 MOCK_LLM 设为 1（零 key 走内置样例）。',
    );
  }
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.MODEL ?? 'deepseek-chat';

  let attempt = 0;
  let lastErr: LlmError | null = null;
  let extraSystem = '';

  while (attempt < 2) {
    attempt++;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          temperature: input.temperature ?? 0.2,
          // 让模型倾向于输出纯 JSON；DeepSeek 兼容该参数
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.system + extraSystem },
            { role: 'user', content: input.user },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastErr = new LlmError('E_HTTP', `模型接口返回 ${res.status}：${body.slice(0, 200)}`, body);
        extraSystem = `\n\n【上次失败】接口返回 ${res.status}，请严格按要求输出 JSON。`;
        continue;
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      const parsed = extractJson(text);
      if (parsed === null) {
        lastErr = new LlmError('E_BAD_JSON', '模型返回的不是合法 JSON。', text);
        extraSystem = '\n\n【上次失败】你返回的不是合法 JSON，请只输出一个 JSON 对象，不要加任何解释文字。';
        continue;
      }

      const checked = input.schema.safeParse(parsed);
      if (!checked.success) {
        const issue = z.prettifyError(checked.error).slice(0, 300);
        lastErr = new LlmError('E_SCHEMA', `模型输出不符合结构约定：${issue}`, text);
        extraSystem = `\n\n【上次失败】输出不符合结构约定：${issue}\n请严格按 schema 重新输出。`;
        continue;
      }

      const out = {
        data: checked.data,
        meta: {
          phase: input.phase,
          model,
          promptHash: promptHashOf(input.system + input.user),
          tokens: json.usage?.total_tokens ?? 0,
          latencyMs: Date.now() - started,
          mock: false,
          attempts: attempt,
        },
      };
      capture(input, out.data, out.meta);
      return out;
    } catch (e) {
      // abort => 超时
      const name = (e as Error).name;
      lastErr =
        name === 'AbortError'
          ? new LlmError('E_TIMEOUT', `模型 ${CALL_TIMEOUT_MS / 1000}s 未返回，已中断。`)
          : new LlmError('E_HTTP', `调用模型时网络出错：${(e as Error).message}`);
      // 超时不重试：再等一次 30s，用户早就走了
      if (name === 'AbortError') break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new LlmError('E_HTTP', '调用模型失败。');
}

/**
 * mock 回放游标。
 *
 * 【键为什么是 `sessionKey + ':' + phase`，挂在 globalThis 上】
 * 1) phase 隔离：同一场会话里多个 phase 共用同一个 sessionKey
 *      - `question`  :: app/api/sessions/[id]/stream/route.ts:291
 *      - `evaluate`  :: app/api/sessions/[id]/answer/route.ts:136
 *      - `report`    :: app/api/sessions/[id]/end/route.ts:134
 *    若游标只按 sessionKey 计数，一次 /answer 里的 evaluate 会把 question 的游标往前推一格，
 *    三问本该 q1→q2→q3，却变成 q1→q3→q2（错位）。序号驱动的前提是每个 phase 各自有序，
 *    所以游标必须按 phase 隔离；跨场仍靠 sessionKey 前缀区分。
 * 2) 挂在 globalThis：Next 开发服务器在热重载 / 多 worker 时会重新求值 lib/llm.ts，
 *    模块顶层的 `const mockCursor = new Map()` 随之被重建，游标归零 → 多个 question 都取回 q1。
 *    与 lib/db.ts 的 `__db` 单例同理，把游标存到 globalThis 才能跨重载存活。
 */
const g = globalThis as unknown as { __mockCursor?: Map<string, number> };
const mockCursor = g.__mockCursor ?? (g.__mockCursor = new Map<string, number>());

/**
 * 复位某次回放的游标。
 *
 * 【为什么必须有这个函数】同一个文档被"重抽"时（用户点第二次抽取、或 revise 重审），
 * 若游标不复位，第二次就会从 seq 末尾继续取，直接抛 E_MOCK_MISS → 0 条结果。
 * 表现为"重抽一次就把质疑点全弄没了"，比抽不出来更让人困惑。
 */
export function resetMockCursor(sessionKey: string): void {
  // 键是 `sessionKey:phase`，复位要把这场会话名下的所有 phase 一起清掉
  for (const k of [...mockCursor.keys()]) {
    if (k === sessionKey || k.startsWith(`${sessionKey}:`)) mockCursor.delete(k);
  }
}

async function callMock(input: CallInput): Promise<{ data: unknown; meta: CallMeta }> {
  const { loadFixture, loadAll } = await import('./mock');
  const all = loadAll(input.phase);
  const key = `${input.sessionKey}:${input.phase}`;
  const seq = mockCursor.get(key) ?? 0;
  mockCursor.set(key, seq + 1);

  /**
   * 【耗尽时循环回放，而不是报 E_MOCK_MISS】
   *
   * 真实踩过：`personas.json` 只有 1 条，而游标按 `personas:${docId}` 在同一进程内持续递增。
   * 演示时每建一次会话就消耗一条 —— 第 2 次之后直接报「没有第 2 条 personas 回放数据」。
   * 后果是**演示者连点几次就再也建不出会话**，而界面上看不出任何原因。
   *
   * 为什么循环是安全的：mock 是**序号驱动**（C15），同一场内顺序固定，
   * 所以"第 n 次问话取第 (n mod total) 条"在一个演示会话内仍然自洽；
   * 跨会话复用同一条人设也完全合理——人设本来就是"这份材料的固定三位评委"。
   *
   * 什么情况下仍然报错：`all.length === 0`，即**这个 phase 一条 fixture 都没有**。
   * 那才是真正的剧本缺失，必须说清楚。
   */
  if (all.length === 0) {
    throw new LlmError(
      'E_MOCK_MISS',
      `演示模式下「${input.phase}」没有任何回放数据。这通常意味着这个环节的 fixture 还没录 —— 演示模式只支持内置样例与固定回答顺序。`,
    );
  }

  const idx = seq % all.length;
  const entry = loadFixture(input.phase, idx);
  if (!entry) {
    throw new LlmError('E_MOCK_MISS', `演示模式下取不到「${input.phase}」的回放数据（第 ${idx + 1} 条）。`);
  }

  const checked = input.schema.safeParse(entry.response);
  if (!checked.success) {
    // mock 也必须过同一套 zod：否则复现是假的
    throw new LlmError(
      'E_SCHEMA',
      `回放数据不符合当前结构约定：${z.prettifyError(checked.error).slice(0, 300)}`,
      JSON.stringify(entry.response).slice(0, 500),
    );
  }

  return {
    data: checked.data,
    meta: {
      phase: input.phase,
      model: 'mock-replay',
      promptHash: promptHashOf(input.system + input.user),
      tokens: 0,
      latencyMs: 0,
      mock: true,
      attempts: 1,
    },
  };
}

/**
 * 流式出口（SSE 专用）。
 *
 * 与 callLLM 共用**同一个预算池**：流式不能成为绕过 S6「单场 ≤30 次」的后门。
 * 与 callLLM 的差别只有三点：
 *   1. 请求带 `stream: true`，响应按 SSE 行读取，一有增量就 yield；
 *   2. 不再做"整批 zod 校验后重试 1 次"——流式已经吐了一半的字，
 *      再重试等于把用户看到的前半句吞掉。改为**收流结束后统一校验**，
 *      校验失败抛 E_SCHEMA 由路由发 error 事件（前端展示 fallback）；
 *   3. mock 模式**逐字符回放**已录好的响应文本，让评委机器上也能看到真实流式效果。
 *
 * 为什么 mock 要"假装流式"而不是一次性返回：
 *   演示的 15% 是"如流式、思考可视化"。若 mock 直接整段返回，
 *   评委在零 key 模式下看到的是一整块文字瞬间出现——流式这个卖点当场消失。
 */
export async function* callLLMStream(input: CallInput): AsyncGenerator<string, { data: unknown; meta: CallMeta }, void> {
  const used = budget.get(input.sessionKey) ?? 0;
  if (used >= MAX_CALLS_PER_SESSION) {
    throw new LlmError(
      'E_BUDGET',
      `本场已用尽 ${MAX_CALLS_PER_SESSION} 次模型调用预算。请结束本场并出报告。`,
    );
  }
  // S6 并发闸：在流式入口**同步**占位，避免"两条流都通过了预算检查"的竞态。
  // 注意 acquire 必须在任何 await 之前，否则两条并发的流都能看到"还有空位"。
  acquire(input.sessionKey);
  budget.set(input.sessionKey, used + 1);

  try {
    return yield* streamBody(input);
  } finally {
    release(input.sessionKey);
  }
}

async function* streamBody(input: CallInput): AsyncGenerator<string, { data: unknown; meta: CallMeta }, void> {
  const started = Date.now();

  if (isMock()) {
    const { loadFixture, loadAll } = await import('./mock');
    const all = loadAll(input.phase);
    const key = `${input.sessionKey}:${input.phase}`;
    const seq = mockCursor.get(key) ?? 0;
    mockCursor.set(key, seq + 1);

    // 与 callMock 同一套策略：耗尽则循环回放（序号驱动下是自洽的），
    // 只有"一条 fixture 都没有"才报 E_MOCK_MISS。原因见 callMock 里的长注释。
    if (all.length === 0) {
      throw new LlmError(
        'E_MOCK_MISS',
        `演示模式下「${input.phase}」没有任何回放数据。这通常意味着这个环节的 fixture 还没录 —— 演示模式只支持内置样例与固定回答顺序。`,
      );
    }
    const idx = seq % all.length;
    const entry = loadFixture(input.phase, idx);
    if (!entry) {
      throw new LlmError('E_MOCK_MISS', `演示模式下取不到「${input.phase}」的回放数据（第 ${idx + 1} 条）。`);
    }
    // 把录制时的结构化响应拍平成"模型会输出的那段 JSON 文本"，再按字符吐出去
    const text = JSON.stringify(entry.response);
    for (let i = 0; i < text.length; i += 3) {
      yield text.slice(i, i + 3);
    }
    const checked = input.schema.safeParse(entry.response);
    if (!checked.success) {
      throw new LlmError(
        'E_SCHEMA',
        `回放数据不符合当前结构约定：${z.prettifyError(checked.error).slice(0, 300)}`,
        JSON.stringify(entry.response).slice(0, 500),
      );
    }
    const meta: CallMeta = {
      phase: input.phase,
      model: 'mock-replay',
      promptHash: promptHashOf(input.system + input.user),
      tokens: 0,
      latencyMs: 0,
      mock: true,
      attempts: 1,
    };
    await logCall(meta, 1);
    return { data: checked.data, meta };
  }

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new LlmError(
      'E_NO_KEY',
      '未配置 DEEPSEEK_API_KEY。若只是想复现演示，请把 MOCK_LLM 设为 1（零 key 走内置样例）。',
    );
  }
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.MODEL ?? 'deepseek-chat';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  // 调用方（路由）在客户端断开时 abort，要把上游一起掐掉（S6 不留孤儿请求）
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onOuterAbort);

  let full = '';
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: input.temperature ?? 0.2,
        response_format: { type: 'json_object' },
        stream: true,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new LlmError('E_HTTP', `模型接口返回 ${res.status}：${body.slice(0, 200)}`, body);
    }

    for await (const delta of readUpstream(res.body, controller.signal)) {
      full += delta;
      yield delta;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new LlmError('E_TIMEOUT', `模型 ${CALL_TIMEOUT_MS / 1000}s 未返回，已中断。`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }

  const parsed = extractJson(full);
  if (parsed === null) {
    throw new LlmError('E_BAD_JSON', '模型返回的不是合法 JSON。', full);
  }
  const checked = input.schema.safeParse(parsed);
  if (!checked.success) {
    const issue = z.prettifyError(checked.error).slice(0, 300);
    throw new LlmError('E_SCHEMA', `模型输出不符合结构约定：${issue}`, full);
  }

  const meta: CallMeta = {
    phase: input.phase,
    model,
    promptHash: promptHashOf(input.system + input.user),
    tokens: Math.ceil(full.length / 2), // 流式没有 usage，按字符数粗估，仅供展示
    latencyMs: Date.now() - started,
    mock: false,
    attempts: 1,
  };
  capture(input, checked.data, meta);
  await logCall(meta, 1);
  return { data: checked.data, meta };
}

/** llm_logs 写入（流式与非流式共用，失败不影响主流程） */
async function logCall(meta: CallMeta, ok: 0 | 1): Promise<void> {
  try {
    const { q } = await import('./db');
    q.run(
      `insert into llm_logs(id, phase, model, prompt_hash, tokens, latency_ms, ok, created_at)
       values(?,?,?,?,?,?,?,?)`,
      crypto.randomUUID(),
      meta.phase,
      meta.model,
      meta.promptHash,
      meta.tokens,
      meta.latencyMs,
      ok,
      new Date().toISOString(),
    );
  } catch {
    // 日志写失败不能影响主流程（但会被 ai-log 记一笔）
  }
}

/**
 * 唯一入口。预算检查在**分支之前**，因此 mock 也受限——
 * 这保证"mock 下的行为"与"真实下的行为"在预算维度也一致。
 */
export async function callLLM(input: CallInput): Promise<{ data: unknown; meta: CallMeta }> {
  const used = budget.get(input.sessionKey) ?? 0;
  if (used >= MAX_CALLS_PER_SESSION) {
    throw new LlmError(
      'E_BUDGET',
      `本场已用尽 ${MAX_CALLS_PER_SESSION} 次模型调用预算。请结束本场并出报告。`,
    );
  }
  // S6 并发闸：占位与预算计数必须**同一拍**完成，中间不许 await
  acquire(input.sessionKey);
  budget.set(input.sessionKey, used + 1);

  try {
    const out = isMock() ? await callMock(input) : await callReal(input);
    await logCall(out.meta, 1);
    return out;
  } finally {
    release(input.sessionKey);
  }
}
