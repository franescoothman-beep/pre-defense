// components/Bench.tsx —— 评审席横条（L1）
//
// 【这次只做静态】按用户指令：先立"三个座位"的骨架，不接流、不做输入框。
// 所以这个组件是**纯展示**：只接收数据、只决定当前/已问/未轮到三态怎么渲染，
// 不发起请求、不监听事件、不持有流状态。接流是下一拍的事。
//
// 三个状态（§3.2 L1）：
//   current = 当前说话者 → 朱红下划线 + 呼吸点，不透明
//   past    = 已问过     → 整块降透明度，无呼吸点
//   idle    = 未轮到     → 正常不透明，无呼吸点
//
// 为什么状态由外部传入而不是组件自己算：
//   "谁在说话"是状态机（lib/state.ts）的结论，不该由展示层再推一遍。
//   两处各算一次，必然分叉——分叉的第一现场就是"横条高亮的人和正文里的发言人不是同一位"。

import './Bench.css';

export type BenchDimension = 'logic' | 'evidence' | 'depth' | 'expression';

export type BenchPersona = {
  id: string;
  name: string;
  /** 服务端排定的质疑类型（method / engineering / value），仅作 info，不参与配色 */
  role: string;
  focus: string;
  /** 维度决定标签配色（颜色只编码数据，与全局四维传统色同源） */
  dimension: BenchDimension;
};

export type BenchSeatState = 'current' | 'past' | 'idle';

export type BenchProps = {
  personas: BenchPersona[];
  /** 当前说话者的 persona id；没有则为 null（例如会话已结束） */
  currentId: string | null;
  /** 已经问过的 persona id 列表 */
  pastIds: string[];
  /** 每位评委的名字与轮次文案（如 "第 1 问 / 共 3 问"） */
  roundLabel?: (persona: BenchPersona, index: number) => string;
};

const DIM_LABEL: Record<BenchDimension, string> = {
  logic: '逻辑链',
  evidence: '证据',
  depth: '技术深度',
  expression: '表达',
};

function seatStateOf(id: string, currentId: string | null, pastIds: string[]): BenchSeatState {
  if (id === currentId) return 'current';
  if (pastIds.includes(id)) return 'past';
  return 'idle';
}

export function Bench({ personas, currentId, pastIds, roundLabel }: BenchProps) {
  return (
    <nav className="bench" aria-label="评审席">
      <div className="bench-seats">
        {personas.map((p, i) => {
          const state = seatStateOf(p.id, currentId, pastIds);
          const round = roundLabel?.(p, i);
          return (
            <div
              key={p.id}
              className={`seat is-${state}`}
              // 让屏幕阅读器也知道"现在是谁在说话"，而不是只有颜色
              aria-current={state === 'current' ? 'true' : undefined}
            >
              <div className="seat-head">
                <h3 className="seat-name">{p.name}</h3>
                <span className={`seat-tag t-${p.dimension}`}>{DIM_LABEL[p.dimension]}</span>
                {/* 呼吸点只在当前说话者身上出现，其余状态由 CSS 压暗 */}
                <span className="seat-pulse" aria-hidden="true" />
              </div>
              <p className="seat-focus">{p.focus}</p>
              {round ? <div className="seat-round">{round}</div> : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
