/**
 * 四个修正 Box（2×2 并列）
 *
 * 概念前提（重要）：
 * 四个修正都是**乘法系数且不超过上限** —— 修正值越大惩罚越轻，等于上限即最优，
 * 趋近 0 则该项得点几乎被压光。因此「修正值」实为**保留比例**：
 *     保留比例 = 修正值 / 上限
 * 大于 1 的部分本来就被上限截掉，截断后的值才是真正参与计算的那个。
 *
 * 着色规则（两套信号并存、互不干扰）：
 *   ① 到达上限 → label 行右侧的**上限数值**变药红（表示约束生效）
 *   ② 保留比例过低 → **Box 背景**着色
 *        保留比例 <= 40%  背景标黄
 *        保留比例 <= 20%  背景药红
 *   其余情况背景保持纸白。
 */

import type { CorrectionInfo, ScoreResult } from '../calc/score'
import { round2 } from '../calc/score'
import { toPercent } from '../calc/scale'
import { SectionLabel } from './ScoreViz'

type CorrectionKey = 'a' | 'b' | 'c' | 'd'

const DEFS: { key: CorrectionKey; label: string; color: string }[] = [
  { key: 'a', label: '修正 A - 互动', color: 'var(--color-vibe)' },
  { key: 'b', label: '修正 B - 收藏', color: 'var(--color-fav)' },
  { key: 'c', label: '修正 C - 硬币', color: 'var(--color-coin)' },
  { key: 'd', label: '修正 D - 播放', color: 'var(--color-play)' },
]

/** 重罚判据（保留比例） */
const WARN_RATIO = 0.4
const CRITICAL_RATIO = 0.2

const AMBER = '#b8860b'

type Severity = 'ok' | 'warn' | 'critical'

function severityOf(retention: number): Severity {
  if (retention <= CRITICAL_RATIO) return 'critical'
  if (retention <= WARN_RATIO) return 'warn'
  return 'ok'
}

/** 背景色：标黄 / 药红；正常时交由 Paper 底色 */
function severityBackground(s: Severity): string | undefined {
  if (s === 'critical') return 'color-mix(in srgb, var(--color-alert) 10%, transparent)'
  if (s === 'warn') return `color-mix(in srgb, ${AMBER} 12%, transparent)`
  return undefined
}

/** 修正值不可能为负，所以 << 100% 一律钳到 0 */
function retentionPercent(info: CorrectionInfo): number {
  return Math.max(0, toPercent(info.ratioToMax))
}

function CorrectionBox({
  label,
  color,
  info,
}: {
  label: string
  color: string
  info: CorrectionInfo
}) {
  const severity = severityOf(info.ratioToMax)
  const pct = retentionPercent(info)

  return (
    <div className="border border-ink px-2.5 py-2" style={{ background: severityBackground(severity) }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px]">{label}</span>
        {/* 到达上限时，「上限」与数值一起标红 */}
        <span
          className="nums text-[10px] shrink-0"
          style={{ color: info.capped ? 'var(--color-alert)' : 'var(--color-muted)' }}
        >
          上限 {info.max}
        </span>
      </div>

      {/* 修正值的原始数值（显示原始值，不做百分比换算） */}
      <div className="nums text-[17px] leading-none mt-1.5" style={{ color }}>
        {round2(info.value).toFixed(2)}
      </div>

      {/* 保留比例进度条（填充恒为该得点家族色，仅背景承担告警语义） */}
      <div className="mt-2 flex items-center gap-2">
        <div className="grow border border-ink h-2.5">
          <div style={{ width: `${pct}%`, height: '100%', background: color }} />
        </div>
        <span className="nums text-[11px] w-12 text-right text-muted">{pct}%</span>
      </div>
    </div>
  )
}

export function CorrectionBoxes({ result }: { result: ScoreResult }) {
  return (
    <div>
      <SectionLabel>修正值</SectionLabel>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {DEFS.map((d) => (
          <CorrectionBox
            key={d.key}
            label={d.label}
            color={d.color}
            info={result.corrections[d.key]}
          />
        ))}
      </div>
    </div>
  )
}
