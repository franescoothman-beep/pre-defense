/**
 * 探针（两阶段）：重启 dev server 后，同一会话的第 2 问是否仍然正确。
 *
 * 复现过的事故（2026-11-15）：
 *   第 1 问（陈评委 · 评测集）→ 我改代码重启 → 第 2 问席位是许教授，
 *   题面却又回到陈评委那句评测集问题 —— 因为回放游标挂在 globalThis，重启即归零。
 *
 * 修法：question / evaluate 的序号改由「库里已问几问 / 已答几次」推导（replaySeq），
 * 游标只剩同一进程内的兜底作用。这条探针就是那次事故的回归测试 ——
 * 单元测试只能断言"传了 replaySeq"，只有真的 kill 进程再续会话才证明接得上。
 *
 * 用法：
 *   node scripts/probe-replay-seq.mjs phase1     # 建会话、答掉第 1 问与它的追问，打印 sessionId
 *   <重启服务>
 *   node scripts/probe-replay-seq.mjs phase2 <sessionId> [q1文本]   # 只取下一问，比对题面
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const DOC = '07b4f607-5393-4617-82b4-a5ea67e605dc';
const ANSWER = '这一问我们确实考虑了。800 条评测集在多轮调优里反复用过，96.8% 正是调在这同一批上算的。';

async function createSession() {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: DOC, mode: 'quick' }),
  });
  if (!r.ok) throw new Error(`建会话失败 ${r.status} ${await r.text()}`);
  return r.json();
}

async function streamOne(sessionId) {
  const r = await fetch(`${BASE}/api/sessions/${sessionId}/stream`);
  if (!r.ok) throw new Error(`stream 失败 ${r.status}`);
  const text = await r.text();
  let meta = null;
  let question = '';
  let turnId = null;
  for (const block of text.split('\n\n').filter(Boolean)) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (!dataLine) continue;
    let payload;
    try {
      payload = JSON.parse(dataLine);
    } catch {
      continue;
    }
    if (ev === 'meta') meta = payload;
    else if (ev === 'token') question += payload.t ?? '';
    else if (ev === 'done') turnId = payload.turnId ?? null;
  }
  return { meta, question, turnId };
}

async function answer(sessionId, turnId, text) {
  const r = await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnId, answer: text }),
  });
  if (!r.ok) throw new Error(`answer 失败 ${r.status} ${await r.text()}`);
  return r.json();
}

const mode = process.argv[2];

if (mode === 'phase1') {
  const created = await createSession();
  const sid = created.sessionId;
  const q1 = await streamOne(sid);
  console.log(`[问1] ${q1.meta?.persona} :: ${q1.question.slice(0, 44)}`);
  const a1 = await answer(sid, q1.turnId, ANSWER);
  if (a1.decision === 'followup') {
    console.log(`[追问] ${a1.followup?.personaName} :: ${a1.followup?.question?.slice(0, 40)}`);
    const a1b = await answer(sid, a1.followup.turnId, ANSWER);
    console.log(`[答追问] decision=${a1b.decision} nextAction=${a1b.nextAction ?? '-'}`);
  } else {
    console.log(`[答1] decision=${a1.decision} nextAction=${a1.nextAction ?? '-'}`);
  }
  console.log(`[SESSION] ${sid}`);
  console.log(`[Q1] ${q1.question}`);
} else if (mode === 'phase2') {
  const sid = process.argv[3];
  if (!sid) throw new Error('phase2 需要 sessionId');
  const q2 = await streamOne(sid);
  const q1 = process.argv[4] ?? '';
  console.log(`[问2] ${q2.meta?.persona} :: ${q2.question.slice(0, 60)}`);
  const same = q1 && q2.question.trim() === q1.trim();
  console.log(same ? '[FAIL] 第 2 问与第 1 问文本相同 —— 回放序号没接上' : '[OK] 第 2 问是新的题面（重启后序号从库里接上）');
  if (same) process.exit(1);
} else {
  console.log('用法：node scripts/probe-replay-seq.mjs phase1 | phase2 <sessionId> [q1文本]');
  process.exit(2);
}
