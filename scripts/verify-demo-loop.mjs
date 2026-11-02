// 一次性验证：MOCK 模式下零 key 完整闭环
// GET /api/demo → POST /api/sessions(quick) → 循环{POST /next → 若是 stream 则 GET /stream 取 turnId → POST /answer} → 报告结构校验
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {}
      }
    }
    return nextResolve(specifier, context);
  },
});

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';

async function streamOnce(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let cur = null;
  let text = '';
  let meta = null;
  let done = null;
  let error = null;
  while (true) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) { cur = null; continue; }
      if (t.startsWith(':')) continue;
      if (t.startsWith('event:')) { cur = t.slice(6).trim(); continue; }
      if (t.startsWith('data:')) {
        const payload = JSON.parse(t.slice(5).trim());
        if (cur === 'token') text += payload.t ?? '';
        else if (cur === 'meta') meta = payload;
        else if (cur === 'done') done = payload;
        else if (cur === 'error') error = payload;
      }
    }
  }
  return { text, meta, done, error };
}

const DEMO_ANSWER =
  '这一问我们确实考虑了。样本来自某市三所小学一学期 1240 条记录，方法上做了哑变量处理，' +
  '但确实没划分训练集与测试集，这是后续要补的。结论推广到全省的场景，我们也只在同批数据上验证过。';

async function main() {
  const demo = await (await fetch(`${BASE}/api/demo`)).json();
  console.log('[demo]', demo.docId, demo.claims, 'claims');
  if (!demo.ok) throw new Error('demo 失败: ' + JSON.stringify(demo));

  const created = await (
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: demo.docId, mode: 'quick' }),
    })
  ).json();
  if (!created.ok) throw new Error('建会话失败: ' + JSON.stringify(created));
  console.log('[session]', created.sessionId, '评委', created.personas.length, '位');
  if (created.personas.length !== 3) throw new Error('评委数不是 3，疑似锚点失配');

  const sessionId = created.sessionId;
  let askCount = 0;

  while (true) {
    const nx = await (
      await fetch(`${BASE}/api/sessions/${sessionId}/next`, { method: 'POST' })
    ).json();

    if (nx.nextAction === 'report' || nx.state === 'ENDED' || nx.state === 'REPORTED') {
      console.log('[next] → 报告就绪:', nx.message ?? '');
      break;
    }
    if (nx.nextAction === 'answer') {
      // 已有 pending turn（例如追问），直接答
      const ans = await (
        await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turnId: nx.pendingTurnId, answer: DEMO_ANSWER, followup: false }),
        })
      ).json();
      if (!ans.ok && ans.code !== 'E_ALREADY_ANSWERED') throw new Error('回答失败: ' + JSON.stringify(ans));
      continue;
    }
    if (nx.nextAction === 'stream') {
      const s = await streamOnce(sessionId);
      if (s.error) throw new Error('stream error: ' + JSON.stringify(s.error));
      if (s.done?.turnId) {
        askCount++;
        const persona = s.meta?.persona ?? '?';
        console.log(`[问 ${askCount}] ${persona} :: ${(s.text || '').slice(0, 28)}`);
        const ans = await (
          await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ turnId: s.done.turnId, answer: DEMO_ANSWER, followup: false }),
          })
        ).json();
        if (!ans.ok && ans.code !== 'E_ALREADY_ANSWERED') throw new Error('回答失败: ' + JSON.stringify(ans));
      }
      continue;
    }
    throw new Error('未知的 nextAction: ' + nx.nextAction);
  }

  const end = await (
    await fetch(`${BASE}/api/sessions/${sessionId}/end`, { method: 'POST' })
  ).json();
  if (!end.ok) throw new Error('出报告失败: ' + JSON.stringify(end));
  const r = end.report ?? end;
  const mrKeys = Object.keys(r.material_risk ?? {});
  const pfKeys = Object.keys(r.performance ?? {});
  console.log('[report] material_risk 维:', mrKeys.length, '| performance 维:', pfKeys.length,
    '| 高风险:', (r.high_risk ?? r.highRisk ?? []).length);
  // 风险分必须来自服务端聚合（整数），模型只写评语 —— 两者不许共名/共色已在 schema 约束
  const mrSample = r.material_risk?.[mrKeys[0]];
  console.log('[report] 风险分示例:', mrSample?.risk_score, '(类型', typeof mrSample?.risk_score, ')');
  if (mrKeys.length < 4) throw new Error('material_risk 维度不足 4');
  if (pfKeys.length < 4) throw new Error('performance 维度不足 4');
  console.log(`[OK] 零 key 闭环走通，共 ${askCount} 问，评委 ${created.personas.length} 位，报告生成成功`);
}

main().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
