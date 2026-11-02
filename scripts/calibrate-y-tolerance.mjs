// y 容差标定扫描（狗粮自查第 5 条的补证）
// 问题：itemsToParagraphs 的 yTolerance=2.5 是经验值——它安全吗？
// 方法：合成两类样本做双向扫描——
//   A 同一行内的基线抖动（jitter 0 → 4.0）：容差太小会把一行拆成多行（漏）；
//   B 相邻两行的行距（spacing 4 → 16）：容差太大会把两行并成一行（错）。
// 对每个候选容差记录「A 全部保持一行」的最大 jitter（可容忍抖动上限）与
// 「B 全部保持两行」的最小 spacing（不并行的最小行距）。
// 结论落在 technical-doc §5.3。
import { registerHooks } from 'node:module';

// 与 test-fixtures.mjs 同一套解析钩子（产品代码相对导入不带扩展名）
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {
          /* 试下一个后缀 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { itemsToParagraphs } = await import('../lib/parse.ts');

const glyphItems = (text, y, jitter = 0) =>
  [...text].map((ch, i) => ({ str: ch, transform: [40 + i * 12, 0, 0, 12, 0, y + (i % 2) * jitter] }));

const TOLERANCES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5];

const rows = [];
for (const tol of TOLERANCES) {
  // A：同一行，jitter 逐档增大，找"仍保持 1 行"的最大 jitter
  let maxJitterOk = null;
  for (let j = 0; j <= 4.001; j += 0.5) {
    const out = itemsToParagraphs(glyphItems('同一行内基线抖动测试', 100, j), tol);
    if (out.length === 1) maxJitterOk = j;
    else break;
  }
  // B：两行，行距逐档减小，找"仍保持 2 行"的最小 spacing
  let minSpacingOk = null;
  for (let s = 16; s >= 3.999; s -= 1) {
    const out = itemsToParagraphs(
      [...glyphItems('上行文字内容', 200), ...glyphItems('下行文字内容', 200 - s)],
      tol,
    );
    if (out.length === 2) minSpacingOk = s;
    else break;
  }
  rows.push({ tol, maxJitterOk, minSpacingOk });
}

console.log('容差 | 同行可容忍抖动上限 | 不并行的最小行距');
for (const r of rows) {
  console.log(
    `${String(r.tol).padEnd(4)} | ${r.maxJitterOk ?? '无（1.0 即拆行）'} | ${r.minSpacingOk ?? '无（16 也并行）'}`,
  );
}

// 2.5 的安全区间断言：抖动 ≤2.4 必须仍是一行，行距 ≥4 必须仍是两行
const t25 = rows.find((r) => r.tol === 2.5);
const safe = (t25?.maxJitterOk ?? -1) >= 2.4 && (t25?.minSpacingOk ?? 99) <= 4;
console.log(safe ? '[OK] 2.5 处于安全区间（抖动上限 ≥2.4 且最小行距 ≤4）' : '[FAIL] 2.5 不在安全区间');
process.exitCode = safe ? 0 : 1;
