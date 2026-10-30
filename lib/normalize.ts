// lib/normalize.ts —— 文本归一化（纯函数，quote 机检与解析共用）
// 规则：全角标点转半角、连续空白压成单空格、去首尾空白、去零宽与控制字符

const FULLWIDTH_MAP: Record<string, string> = {
  '，': ',', '。': '.', '；': ';', '：': ':', '？': '?', '！': '!',
  '（': '(', '）': ')', '［': '[', '］': ']', '｛': '{', '｝': '}',
  '、': ',', '～': '~', '－': '-', '—': '-',
};

/** 归一化：用于 quote 逐字比对。两侧都过这个函数，避免"看起来一样但不命中"。 */
export function norm(input: string): string {
  let s = input.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  s = s.replace(/[，。；：？！（）［］｛｝、～－—]/g, (c) => FULLWIDTH_MAP[c] ?? c);
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/**
 * 逐字命中：quote 与 block.text 在**去掉全部空白**后比对。
 * 为什么连空格的差异也要吃掉：中文 PDF 逐字空格化是常态（`教 育 背 景`），
 * 且模型复述时也常在词间插空格。若只压空格而不去空格，会出现
 * 「看起来一模一样却不命中」的假失败，把命中率打穿。
 * 代价：对纯英文语料可能跨词误命中——本产品语料是中文论文/简历，可接受，且会写进局限。
 */
export function hits(text: string, quote: string): boolean {
  const strip = (s: string) => norm(s).replace(/\s+/g, '');
  const q = strip(quote);
  if (!q) return false;
  return strip(text).includes(q);
}

/** 编辑距离相似度（0–1），用于追问去重（state.ts 的第 4 条规则） */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const m = x.length, n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
