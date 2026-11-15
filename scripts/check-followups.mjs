// 临时核对：quick 档录制路径下，屏幕上到底出现几条追问、分别是哪句
// 严格按真实 UI 状态机 + 真实 SSE 事件解析（event: 名 / data: JSON）
const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const ANSWER = '这一问我们确实考虑了。800 条评测集在多轮调优里反复用过，96.8% 正是调在这同一批上算的，存在过拟合，会切出独立留出集；检索为空时没有显式拒答阈值，当前靠提示词兜底；推广到政务、医疗的场景，目前只有教务一个域的验证。';

function parseSse(chunk, state) {
  const out = [];
  state.buf += chunk;
  const parts = state.buf.split('\n\n');
  state.buf = parts.pop() ?? '';
  for (const block of parts) {
    let ev = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    try { out.push({ ev, data: JSON.parse(dataLines.join('\n')) }); } catch { /* ignore */ }
  }
  return out;
}

async function streamOnce(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const state = { buf: '' };
  let text = '', done = null;
  while (true) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    for (const { ev, data } of parseSse(dec.decode(value, { stream: true }), state)) {
      if (ev === 'token') text += data.t ?? '';
      if (ev === 'done') done = data;
      if (ev === 'error') console.log('  [SSE error]', data);
    }
  }
  return { text, done };
}

async function main() {
  const demo = await (await fetch(`${BASE}/api/demo`)).json();
  const created = await (await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docId: demo.docId, mode: 'quick' }) })).json();
  const sessionId = created.sessionId;
  console.log(`[session] ${sessionId}  评委 ${created.personas?.length ?? '?'} 位`);
  const log = [];
  let mains = 0, follows = 0, pendingTurnId = null;

  for (let guard = 0; guard < 40; guard++) {
    let turnId = pendingTurnId;
    if (!turnId) {
      const nx = await (await fetch(`${BASE}/api/sessions/${sessionId}/next`, { method: 'POST' })).json();
      if (nx.nextAction === 'report' || nx.state === 'ENDED' || nx.state === 'REPORTED') { log.push('→ 报告就绪'); break; }
      if (nx.nextAction === 'answer') { turnId = nx.pendingTurnId; }
      else if (nx.nextAction === 'stream') {
        const s = await streamOnce(sessionId);
        turnId = s.done?.turnId;
        const kind = s.done?.turnKind;
        if (kind === 'followup') {
          follows++;
          log.push(`[追问${follows}] ${nx.persona?.name ?? '?'} :: ${(s.text || '').trim()}`);
        } else {
          mains++;
          log.push(`[主问${mains}] ${nx.persona?.name ?? '?'} :: ${(s.text || '').trim()}`);
        }
      }
    }
    if (!turnId) break;
    const ans = await (await fetch(`${BASE}/api/sessions/${sessionId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnId, answer: ANSWER }) })).json();
    if (ans.decision === 'followup' && ans.followup?.turnId) {
      follows++;
      log.push(`  [追问${follows}] ${ans.followup.persona?.name ?? ans.followup.personaName ?? '?'} :: ${ans.followup.question}`);
      pendingTurnId = ans.followup.turnId;
      continue;
    }
    if (ans.decision === 'end' || ans.nextAction === 'report') { log.push('→ 本段结束'); break; }
    pendingTurnId = null;
  }
  console.log(log.join('\n'));
  console.log(`\n主问 ${mains} 条，追问 ${follows} 条`);
}
main().catch((e) => { console.error('[ERR]', e.message); process.exit(1); });
