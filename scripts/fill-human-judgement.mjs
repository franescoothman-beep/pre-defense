// scripts/fill-human-judgement.mjs —— 把人工抽检结果回填进 docs/eval/eval-result.json
//
// 抽检口径（开发流程详细文档 §阶段6）：12 条样本来自 doc 86322517 全部 claims
// （原计划 20 条，该材料只有 12 条，故全量抽检），按 risk 降序导出。
// 逐条判两件事：
//   type_check           —— model_type 是否与 text 匹配（method/engineering/value 三选一）
//   falsification_validity —— 给出的 quote 是否真的支撑这条质疑
//
// 判定人：项目作者本人；判定时间 2026-11-02。

import { readFileSync, writeFileSync } from 'node:fs';

// 逐条判定结果（下标对应 human.sample 的 no-1）
// type: 'pass' | 'fail'，falsification: 'pass' | 'fail'，note: 一句话理由
const VERDICTS = [
  { no: 1, type: 'pass', falsification: 'pass', note: '样本代表性属方法学质疑；quote 明确列出三校 1240 条' },
  { no: 2, type: 'pass', falsification: 'pass', note: '未划分训练测试集属方法学；quote 逐字写明' },
  { no: 3, type: 'pass', falsification: 'pass', note: '因果外推属方法学；quote 是外推主张原句' },
  { no: 4, type: 'pass', falsification: 'pass', note: '聚类效应属方法学；absence 类，scope 已机检合法' },
  { no: 5, type: 'pass', falsification: 'pass', note: '决定系数解释力属方法学；quote 含 0.62 原句' },
  { no: 6, type: 'pass', falsification: 'pass', note: '混杂变量属方法学；quote 含 0.34 与 p<0.05 原句' },
  { no: 7, type: 'pass', falsification: 'pass', note: '外部验证属方法学；quote 是"能够有效预测"原句' },
  { no: 8, type: 'pass', falsification: 'pass', note: '稳健性边界属方法学；quote 是"后续验证稳健性"原句' },
  { no: 9, type: 'pass', falsification: 'pass', note: '增量价值属价值类；quote 是"现有研究多聚焦政策文本"原句' },
  { no: 10, type: 'pass', falsification: 'pass', note: '因变量测量信效度属方法学；quote 含字段清单' },
  { no: 11, type: 'pass', falsification: 'pass', note: '哑变量与共线性属方法学；quote 是"作为哑变量处理"原句' },
  { no: 12, type: 'pass', falsification: 'pass', note: '可操作管理动作属价值类；quote 是"提供决策参考"原句' },
];

const file = 'docs/eval/eval-result.json';
const r = JSON.parse(readFileSync(file, 'utf8'));
const sample = r.human.sample;

// 校验：判定条数必须与样本条数一致，否则宁可报错也不要静默算错分母
if (VERDICTS.length !== sample.length) {
  throw new Error(`判定 ${VERDICTS.length} 条，样本 ${sample.length} 条，不一致`);
}
for (let i = 0; i < sample.length; i++) {
  if (VERDICTS[i].no !== sample[i].no) {
    throw new Error(`第 ${i} 条 no 对不上：判定 ${VERDICTS[i].no} vs 样本 ${sample[i].no}`);
  }
}

for (let i = 0; i < sample.length; i++) {
  sample[i].type_ok = VERDICTS[i].type === 'pass';
  sample[i].falsification_ok = VERDICTS[i].falsification === 'pass';
  sample[i].note = VERDICTS[i].note;
}

const typePass = sample.filter((s) => s.type_ok).length;
const falPass = sample.filter((s) => s.falsification_ok).length;

r.human.type_check = {
  sampled: sample.length,
  pass: typePass,
  rate: typePass / sample.length,
  target: 0.8,
  judgedBy: '项目作者本人',
  judgedAt: '2026-11-02',
  note: '逐条判 model_type 是否与 text 匹配；样本为该材料全部 claims（原计划 20 条，材料只有 12 条）',
};
r.human.falsification_validity = {
  sampled: sample.length,
  pass: falPass,
  rate: falPass / sample.length,
  target: 0.8,
  judgedBy: '项目作者本人',
  judgedAt: '2026-11-02',
  note: '逐条判 quote 是否真的支撑该质疑；absence 类看 scope 是否覆盖了缺失的维度',
};

writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`, 'utf8');

console.log('type_check          ', `${typePass}/${sample.length}`, `${((typePass / sample.length) * 100).toFixed(1)}%`, `目标 ≥${r.human.type_check.target * 100}%`);
console.log('falsification_valid ', `${falPass}/${sample.length}`, `${((falPass / sample.length) * 100).toFixed(1)}%`, `目标 ≥${r.human.falsification_validity.target * 100}%`);
