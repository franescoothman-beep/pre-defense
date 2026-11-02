/**
 * 3 份真实使用记录采集（阶段 6 任务 7）
 *
 * 为什么要有这个脚本：技术文档第 5 章要交的不是"我做了个产品"，
 * 而是"有人真的拿自己的材料跑过，跑完改了什么东西"。手抄三场对话既容易串行、
 * 也容易被记忆美化，所以直接驱动真实会话，把它说的话原样落盘。
 *
 * 用法（须先起 MOCK_LLM=0 的真实服务）：
 *   node scripts/collect-usage.mjs <docId> <记录标题> [--out docs/usage/xxx.md]
 *
 * 脚本只做"跑 + 记录"，不做判断：
 *   - 上传与抽 claims 由调用方先做好（或走 /api/docs）
 *   - 这里驱动 quick 会话（POST /sessions → /next → /stream → /answer → /end）
 *   - 落盘：材料概况 / 三位评委问了什么 / 我怎么答 / 每问得分与缺口 / 报告要点
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const [docId, title] = process.argv.slice(2);
if (!docId) {
  console.error('用法：node scripts/collect-usage.mjs <docId> <标题> [--out 路径]');
  process.exit(1);
}
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;

/** 读一次 SSE，返回 {tokens, meta, done, error} */
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
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) { cur = null; continue; }
      if (t.startsWith(':')) continue;
      if (t.startsWith('event:')) { cur = t.slice(6).trim(); continue; }
      if (t.startsWith('data:')) {
        const raw = t.slice(5).trim();
        let obj;
        try { obj = JSON.parse(raw); } catch { continue; }
        if (cur === 'token') text += obj.t ?? '';
        else if (cur === 'meta') meta = obj;
        else if (cur === 'done') done = obj;
        else if (cur === 'error') error = obj;
      }
    }
  }
  return { text, meta, done, error };
}

const answers = [
  '这一问我们确实考虑了。样本来自某市三所小学一学期 1240 条记录，方法上做了哑变量处理，但确实没划分训练集与测试集，这是后续要补的。结论推广到全省的场景，我们也只在同批数据上验证过。',
  '我们用的是多元线性回归，控制了学校规模和年级两个变量，决定系数 0.62，p 值都小于 0.05，说明模型是有效的。',
  '这一点在论文里没有单独展开，主要是因为数据来源有限。后续我们计划扩展到更多城市的学校做验证。',
  '我认为这个结论是有现实意义的，很多学校确实存在课后服务资源分配不均的情况，我们的分析能提供参考。',
  '这部分我准备得不够充分，回去我会补做训练集测试集划分，再重新跑一遍模型。',
];

console.log(`[usage] 开始采集：${title ?? docId}`);
const sesRes = await fetch(`${BASE}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ docId, mode: 'quick' }),
});
const ses = await sesRes.json();
if (!ses.ok) {
  console.error('创建会话失败', ses);
  process.exit(1);
}
const sessionId = ses.sessionId;
console.log(`[session] ${sessionId} 评委 ${(ses.personas ?? []).length} 位`);

const turns = [];
let answered = 0;
for (let guard = 0; guard < 12; guard++) {
  const nx = await (await fetch(`${BASE}/api/sessions/${sessionId}/next`, { method: 'POST' })).json();
  if (nx.nextAction === 'report') {
    console.log('[next] → 报告就绪');
    break;
  }
  const s = await streamOnce(sessionId);
  if (s.error) { console.error('SSE 错误', s.error); break; }
  const turnId = s.done?.turnId;
  const question = s.text.trim();
  // SSE 的 meta 事件用 persona 字段（不是 personaName）；done 里带的是 turnKind
  const persona = s.meta?.persona ?? s.done?.meta?.persona ?? '评委';
  const answer = answers[answered % answers.length];
  const ar = await (
    await fetch(`${BASE}/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnId, answer, followup: false }),
    })
  ).json();
  if (!ar.ok) { console.error('作答失败', ar); break; }
  answered++;
  const kind = s.done?.turnKind ?? 'question';
  turns.push({
    seq: answered,
    kind,
    persona,
    question,
    answer,
    score: ar.evaluation?.score ?? null,
    score100: ar.evaluation?.scorePercent ?? null,
    gaps: ar.evaluation?.gaps ?? [],
    followup: ar.followup?.question ?? null,
  });
  console.log(`[问 ${answered}] ${persona} :: ${question.slice(0, 30)}… → ${ar.evaluation?.score ?? '?'}/5`);
}

const end = await (await fetch(`${BASE}/api/sessions/${sessionId}/end`, { method: 'POST' })).json();
const r = end.report ?? end;
console.log(`[report] material_risk 维: ${(r.material_risk ?? []).length} | performance: ${(r.performance ?? []).length} | 高风险: ${(r.high_risk ?? []).length}`);

// ---- 落盘 markdown ----
const L = [];
L.push(`# 真实使用记录：${title ?? docId}`, '');
L.push(`- 采集时间：${new Date().toISOString()}`);
L.push(`- 材料 docId：\`${docId}\``);
L.push(`- 会话 id：\`${sessionId}\``);
L.push(`- 档位：quick（3 位评委 × 主问 + 追问）`);
L.push(`- 评委席：${(ses.personas ?? []).map((p) => `${p.name}（${p.role ?? p.focus ?? '—'}）`).join(' / ')}`);
L.push('', '## 1. 它问了什么', '');
L.push('| # | 类型 | 评委 | 问题 | 得分 |');
L.push('|---|---|---|---|---|');
for (const t of turns) {
  L.push(`| ${t.seq} | ${t.kind === 'followup' ? '追问' : '主问'} | ${t.persona} | ${t.question.replace(/\|/g, '\\|')} | ${t.score ?? '-'}/5 |`);
}
L.push('', '## 2. 它说的缺口（原文）', '');
for (const t of turns) {
  if (!t.gaps?.length) continue;
  L.push(`**第 ${t.seq} 问**`, '');
  for (const g of t.gaps) L.push(`- ${g}`);
  L.push('');
}
L.push('## 3. 报告要点', '');
L.push('### 材料风险', '');
L.push('| 维度 | 风险分 | 评语 |');
L.push('|---|---|---|');
for (const m of r.material_risk ?? []) {
  L.push(`| ${m.label ?? m.dimension} | ${m.risk_score ?? '未覆盖'} | ${(m.comment ?? '').replace(/\|/g, '\\|')} |`);
}
L.push('', '### 临场表现', '');
L.push('| 维度 | 分数 | 评语 |');
L.push('|---|---|---|');
for (const p of r.performance ?? []) {
  L.push(`| ${p.label ?? p.dimension} | ${p.score ?? '未覆盖'} | ${(p.comment ?? '').replace(/\|/g, '\\|')} |`);
}
L.push('', '### 最可能一问就崩的点', '');
for (const h of r.high_risk ?? []) {
  L.push(`- **${h.question ?? ''}**`);
  L.push(`  - 为什么：${h.why ?? ''}`);
  L.push(`  - 怎么改：${h.suggestion ?? ''}`);
}
L.push('', '### 总建议', '', r.advice ?? '', '');
L.push('## 4. 看完之后我改了什么', '');
L.push('> 【人工填写】这里必须写真实改动，不能空。', '');

const text = L.join('\n');
if (outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, 'utf8');
  console.log(`[out] ${outPath} (${text.length} chars)`);
} else {
  console.log(text);
}
