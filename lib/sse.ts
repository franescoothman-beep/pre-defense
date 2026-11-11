// lib/sse.ts —— SSE 事件编码与流式读上游（纯函数 + 一个受控的读取循环）
//
// 为什么单独一个文件、而不是塞进路由：
//   SSE 最容易出错的地方全在"字节边界"和"生命周期"上，把它们写成纯函数才能在单测里钉死。
//   路由只负责"解析入参 → 调这里 → 返回 Response"（§3.6 路由层禁令）。
//
// 四个真实失败模式（每一条都在阶段 3 的 ai-log 里有对应记录）：
//
// 1) **事件之间必须有空行**。少一个 \n，浏览器会把两个事件粘成一个，前端只看到 meta 看不到 token。
//    这条最隐蔽：curl 里看起来完全正常，只有前端解析器会挂。
//
// 2) **payload 里绝不能出现裸换行**。`JSON.stringify` 会把 LF/CR 转义成 `\\n`，
//    所以正常情况下是安全的；但若哪天有人把非 JSON 的纯文本直接当 payload 传进来，
//    裸 \n 就会按 SSE 规范提前结束 data 字段，一条事件被劈成两半、后半截变成非法行被丢弃。
//    `encodeEvent` 里保留了逐行加前缀的兜底，注释也把这条写清楚（别把它误记成"JSON 会劈开事件"）。//
// 3) **不能把整个 JSON 里的中文直接拼进去**。JSON.stringify 不转义非 ASCII 是合法的，
//    但 SSE 传输层按 UTF-8 逐字节，多字节字符若被上游 chunk 从中间切断，
//    直接 JSON.parse 会在流式边界上偶发失败。所以解析上游时按**整行**处理，不按字节。
//
// 4) **连接必须能被关掉**。客户端刷新/关页面时 request.signal 会 abort，
//    若不监听，上游 fetch 会一直挂着跑到 30s 超时并继续烧预算（S6）。

import type { CallMeta } from './llm';

/** 契约 §3.6 的四种事件。名字写死，前端按名字分支。 */
export type SseEventName = 'meta' | 'token' | 'done' | 'error';

export type SseMeta = {
  persona: string;
  qIndex: number;
  claimId: string;
  blockIdx: number;
  /** 扫读原文思考态要显示的那两行原文 */
  source?: string;
  page?: number | null;
  section?: string | null;
  locatorKind?: 'quote' | 'absence';
  verified?: 0 | 1 | null;
};

export type SseError = {
  code: 'timeout' | 'bad_json' | 'schema' | 'no_key' | 'http' | 'budget' | 'busy' | 'aborted' | 'internal';
  /** 人话兜底文案。前端直接展示这句，不要再翻译一次。 */
  fallback: string;
};

/**
 * 把一条事件编码成 SSE 文本块。
 *
 * 末尾的 `\n\n` 是**两个**换行：第一个结束 `data:` 行，第二个结束整个事件。
 * 少了它，下一个 event 会被当作本条事件的续行。
 *
 * 【关于 data 里的换行，事实要写准】
 * `JSON.stringify` 会把 LF(`\n`) 与 CR(`\r`) 转义成 `\\n` / `\\r` **两个字符**，
 * 所以经过它序列化之后的文本里**根本没有裸换行**，SSE 传输层不会被劈开。
 * 下面那句 `split('\n')` 是**兜底**：万一有人把非 JSON 的纯文本塞进 payload
 * （比如直接 `encodeEvent('token', 原始文本)`），裸换行就会把一条事件拆成两半。
 * 兜底留着，但注释不能写成"JSON 里的中文换行会劈开事件"——那是错的技术描述。
 *
 * 真正需要注意的反而是 **U+2028 / U+2029**：`JSON.stringify` **不转义**它们，
 * 它们会原样出现在输出里。SSE 规范只把 LF/CR/CRLF 当行分隔符，
 * 所以 U+2028 不会破坏事件边界（前端 `JSON.parse` 也能正常解析）。
 * 这条写在这里是为了让将来读代码的人不要"顺手"把它们也劈成多行 data。
 */
export function encodeEvent(name: SseEventName, payload: unknown): string {
  const json = JSON.stringify(payload ?? {});
  // 兜底：若 payload 被传入非 JSON 文本（含裸换行），逐行加前缀，避免事件被劈开
  const body = json
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `event: ${name}\n${body}\n\n`;
}

/** 注释/心跳行。用于 SSE 首字节立即到达，以及长思考期间保持连接不被中间层掐断。 */
export function encodeComment(text = 'ok'): string {
  return `: ${text}\n\n`;
}

/**
 * 解析上游 OpenAI 兼容流的一行。
 *
 * DeepSeek / OpenAI 的流式格式是 `data: {...}\n\n`，结束标记是 `data: [DONE]`。
 * 返回：
 *   - `{ kind: 'delta', text }`   —— 有内容增量
 *   - `{ kind: 'done' }`          —— 上游结束
 *   - `{ kind: 'ignore' }`        —— 空行、注释行、非 data 行
 *   - `{ kind: 'error', message }` —— 这一行坏了（不抛，交给调用方决定是否降级）
 */
export type ParsedLine =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'ignore' }
  | { kind: 'error'; message: string };

export function parseUpstreamLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'ignore' };
  if (trimmed.startsWith(':')) return { kind: 'ignore' };
  if (!trimmed.startsWith('data:')) return { kind: 'ignore' };

  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return { kind: 'done' };
  if (payload === '') return { kind: 'ignore' };

  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (json.error?.message) return { kind: 'error', message: json.error.message };
    const d = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
    if (!d) return { kind: 'ignore' };
    return { kind: 'delta', text: d };
  } catch {
    return { kind: 'error', message: `上游返回了无法解析的行：${payload.slice(0, 80)}` };
  }
}

/**
 * 从上游响应体里逐行读出文本增量。
 *
 * 【关键正确性点】按 `\n` 切行，**保留半行的 buffer**。
 * 上游一个 chunk 可能是 `data: {"choices":[{"delta":{"content":"样`，
 * 若不做 buffer 直接 parse，会得到半截 JSON → 每次都在流式边界随机失败。
 * 这也是"首字到达 < 1.5s"能成立的前提：一读到完整行就立刻 yield，不等整个响应结束。
 */
export async function* readUpstream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // 一次 chunk 可能含多行；只处理到最后一个换行，剩下的留给下次
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const parsed = parseUpstreamLine(line);
        if (parsed.kind === 'delta') yield parsed.text;
        else if (parsed.kind === 'done') return;
        nl = buf.indexOf('\n');
      }
    }

    // 收尾：把残行也处理掉（有的服务端最后一行不带换行）
    if (buf.trim()) {
      const parsed = parseUpstreamLine(buf);
      if (parsed.kind === 'delta') yield parsed.text;
    }
  } finally {
    // 无论正常结束还是被 abort，都要释放读锁，否则上游连接不关
    try {
      await reader.cancel();
    } catch {
      /* 已经关闭就不用再 cancel */
    }
  }
}

/** S6：SSE 连接 60s 硬断 */
export const SSE_HARD_TIMEOUT_MS = 60_000;

/** 每积攒多少字符推一次 token 事件。太小会把事件流打碎，太大就没有流式手感。 */
export const TOKEN_FLUSH_CHARS = 6;

/**
 * 增量 JSON 字段解包器：从模型的流式 JSON 里**只抠出某个字符串字段的值**并逐段吐出来。
 *
 * 【为什么必须在服务端做这件事】
 * 上游是 `response_format: json_object`，所以模型吐出的增量是
 * `{"question": "这 800 条评测集是怎么选出来的` 这样**带 JSON 语法**的片段。
 * 若原样透传给前端，聊天页会逐字显示 `{"question": "` 和结尾的 `"}` ——
 * 评委第一次看到的就是一串代码，而不是评委在说话。流式这个卖点当场变成 bug。
 *
 * 做法：一个极小的状态机，按字符走，只收集目标字段引号内的字符，并正确处理转义。
 * 只支持"顶层对象里的字符串字段"，够用且绝不误吞：
 *   - 遇到 `"question"` 键 → 进入"等冒号 → 等引号 → 收值"三态
 *   - 值内的 `\"` / `\\` / `\n` / `\uXXXX` 按 JSON 转义规则还原
 *   - 收到未转义的收尾引号 → 结束
 *
 * 这不是"随便解析一下"：写错一个转义分支，中文引号或换行就会漏字。
 */
export function createFieldStreamer(fieldName: string) {
  /** 目标状态机阶段 */
  type Phase = 'seekKey' | 'afterKey' | 'seekQuote' | 'inValue' | 'done';
  let phase: Phase = 'seekKey';
  let keyBuf = '';
  let esc = false;
  let uniBuf: string | null = null;

  return {
    /** 喂入一段原始增量，返回其中属于 fieldName 的**文本增量**（可能为空串） */
    push(chunk: string): string {
      if (phase === 'done') return '';
      let out = '';

      for (const ch of chunk) {
        // 【必须在循环内检查 done】值已经收尾后，同一个 chunk 里剩下的字符
        // （例如结尾的 `}`）不属于字段值。少了这一个 continue，
        // 结果就会变成「样本能代表全市吗？}」—— 收尾大括号跟着一起流给前端。
        // 这个 bug 只在"切片边界恰好落在收尾引号之后"时出现，
        // 按 1 字切不会暴露、按 5 字切就暴露，所以流式解析必须按多粒度测。
        if (phase === 'done') break;

        if (phase === 'seekKey') {
          // 在顶层找 `"question"` 这个键；用一个滚动的引号内缓冲判断
          if (ch === '"') {
            keyBuf = '';
            phase = 'afterKey';
          }
          continue;
        }

        if (phase === 'afterKey') {
          if (esc) {
            esc = false;
            keyBuf += ch;
            continue;
          }
          if (ch === '\\') {
            esc = true;
            continue;
          }
          if (ch === '"') {
            // 一个完整的键读完了
            if (keyBuf === fieldName) {
              phase = 'seekQuote';
            } else {
              keyBuf = '';
              phase = 'seekKey';
            }
            continue;
          }
          keyBuf += ch;
          continue;
        }

        if (phase === 'seekQuote') {
          if (ch === ':') continue;
          if (ch === '"') {
            phase = 'inValue';
            continue;
          }
          // 不是冒号也不是引号（例如空白）→ 继续等
          if (/\s/.test(ch)) continue;
          // 出现了别的字符 → 说明这个键的值不是字符串，放弃这个键，回去找下一个
          keyBuf = '';
          phase = 'seekKey';
          continue;
        }

        // inValue
        if (uniBuf !== null) {
          uniBuf += ch;
          if (uniBuf.length === 4) {
            const code = Number.parseInt(uniBuf, 16);
            out += Number.isFinite(code) ? String.fromCharCode(code) : '';
            uniBuf = null;
          }
          continue;
        }
        if (esc) {
          esc = false;
          if (ch === 'n') out += '\n';
          else if (ch === 't') out += '\t';
          else if (ch === 'r') out += '\r';
          else if (ch === 'b') out += '\b';
          else if (ch === 'f') out += '\f';
          else if (ch === 'u') uniBuf = '';
          else out += ch; // \" \\ \/ 以及其它未定义转义按字面还原
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          // 未转义的收尾引号 → 值结束
          phase = 'done';
          continue;
        }
        out += ch;
      }

      return out;
    },

    /** 是否已经吐完目标字段 */
    isDone(): boolean {
      return phase === 'done';
    },
  };
}

/** 把 LLM 的 LlmError.code 映射成前端的 fallback 文案（前端直接展示，不再翻译） */
export function errorToSse(code: string, message?: string): SseError {
  const map: Record<string, SseError['code']> = {
    E_TIMEOUT: 'timeout',
    E_BAD_JSON: 'bad_json',
    E_SCHEMA: 'schema',
    E_NO_KEY: 'no_key',
    E_HTTP: 'http',
    E_BUDGET: 'budget',
    E_MOCK_MISS: 'internal',
    // S6 并发闸（lib/llm.ts 的 ConcurrencyError）。它不是一个"错误"，
    // 而是"上一条还没出完字"——文案要说清这一点，否则用户会以为系统坏了。
    E_CONCURRENCY: 'busy',
  };
  const fallback: Record<SseError['code'], string> = {
    timeout: '（评委停顿了一下，请再问一次）',
    bad_json: '（评委这次没组织好语言，请再问一次）',
    schema: '（评委这次没抓准重点，请再问一次）',
    no_key: '（当前未配置模型密钥，无法提问）',
    http: '（网络不稳，评委没听清，请再问一次）',
    budget: '（本场提问次数已达上限，请结束并出报告）',
    busy: '（上一条还在出字，等这一条说完再继续）',
    aborted: '（本场已中断）',
    internal: '（内部错误，请重试）',
  };
  const mapped = map[code] ?? 'internal';
  return { code: mapped, fallback: fallback[mapped] ?? (message ?? fallback.internal) };
}

/** 供前端/测试共用的事件名集合（防止前后端各写一套字符串） */
export const SSE_EVENTS: readonly SseEventName[] = ['meta', 'token', 'done', 'error'] as const;

/**
 * 把 meta 的 CallMeta 附到 SSE 里（指标展示 + MOCK 角标）。
 * 单独拿出来的原因：mock 与真实模式的 meta 字段一致，前端只有一套渲染逻辑。
 */
export function metaFromCall(callMeta: CallMeta): {
  model: string;
  mock: boolean;
  latencyMs: number;
  tokens: number;
  promptHash: string;
} {
  return {
    model: callMeta.model,
    mock: callMeta.mock,
    latencyMs: callMeta.latencyMs,
    tokens: callMeta.tokens,
    promptHash: callMeta.promptHash,
  };
}
