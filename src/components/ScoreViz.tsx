/**
 * 得分可视化的小零件
 *
 * 说明：进度条与得点小格的实际渲染已由 PointBoxes / CorrectionBoxes 内联完成
 * （各自需要不同的叠加与告警行为），此处只保留共用的区块标题。
 */

import type { ReactNode } from 'react'

/** 区块小标题：等宽 + 字距，带下边线 */
export function SectionLabel({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-ink pb-1 mb-2 gap-2">
      <span className="text-[11px] tracking-[0.12em] uppercase">{children}</span>
      {note ? <span className="text-[10px] text-muted text-right">{note}</span> : null}
    </div>
  )
}
