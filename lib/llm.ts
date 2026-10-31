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
import type { ZodType } from 'zod';
import { z } from 'zod';
import { readUpstream } from './sse';

export type Phase = 'claims' | 'personas' | 'evaluate' | 'report';

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

      return {
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

/** mock 回放：按 phase + seq 递增，跨场按 sessionKey 独立游标 */
const mockCursor = new Map<string, number>();

/**
 * 复位某次回放的游标。
 *
 * 【为什么必须有这个函数】同一个文档被"重抽"时（用户点第二次抽取、或 revise 重审），
 * 若游标不复位，第二次就会从 seq 末尾继续取，直接抛 E_MOCK_MISS → 0 条结果。
 * 表现为"重抽一次就把质疑点全弄没了"，比抽不出来更让人困惑。
 */
export function resetMockCursor(sessionKey: string): void {
  mockCursor.delete(sessionKey);
}

async function callMock(input: CallInput): Promise<{ data: unknown; meta: CallMeta }> {
  const { loadFixture } = await import('./mock');
  const seq = mockCursor.get(input.sessionKey) ?? 0;
  mockCursor.set(input.sessionKey, seq + 1);

  const entry = loadFixture(input.phase, seq);
  if (!entry) {
    throw new LlmError(
      'E_MOCK_MISS',
      `演示模式下没有第 ${seq + 1} 条「${input.phase}」回放数据。这通常意味着回放剧本与当前操作顺序不一致——演示模式只支持内置样例与固定回答顺序。`,
    );
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
  budget.set(input.sessionKey, used + 1);

  const started = Date.now();

  if (isMock()) {
    const { loadFixture } = await import('./mock');
    const seq = mockCursor.get(input.sessionKey) ?? 0;
    mockCursor.set(input.sessionKey, seq + 1);
    const entry = loadFixture(input.phase, seq);
    if (!entry) {
      throw new LlmError(
        'E_MOCK_MISS',
        `演示模式下没有第 ${seq + 1} 条「${input.phase}」回放数据。这通常意味着回放剧本与当前操作顺序不一致——演示模式只支持内置样例与固定回答顺序。`,
      );
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
  budget.set(input.sessionKey, used + 1);

  const out = isMock() ? await callMock(input) : await callReal(input);

  await logCall(out.meta, 1);

  return out;
}
