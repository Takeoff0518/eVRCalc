/**
 * 五类得点 Box（并列）+ Top1 叠加背景进度条
 *
 * - 播放得点 Box 额外显示其进入的分支
 * - 叠加层：进度条值 = sqrt(本视频分项得点 / Top1 分项得点)，对数刻度，不显示具体数值
 *   （决策 1 对数刻度；决策 3 不标数值）
 */

import type { ScoreResult } from '../calc/score'
import { round0 } from '../calc/score'
import { overlayProgress } from '../calc/scale'
import { SectionLabel } from './ScoreViz'

const COLOR = {
  play: 'var(--color-play)',
  vib: 'var(--color-vibe)',
  fav: 'var(--color-fav)',
  coin: 'var(--color-coin)',
  like: 'var(--color-like)',
} as const

const nf = new Intl.NumberFormat('en-US')

export interface TopValues {
  play: number
  interaction: number
  favorite: number
  coin: number
  like: number
}

export interface PointBoxesProps {
  result: ScoreResult
  /** Top1 视频的各类得点；缺失时不显示叠加层 */
  top?: TopValues
  /** 叠加层基准说明，如「735 期 Top 1」 */
  topLabel?: string
}

interface ItemDef {
  key: keyof TopValues
  name: string
  color: string
  value: number
  /** 叠加层用极低透明度填充；赞的纯黑需特殊处理 */
  overlayColor: string
}

function OverlayStrip({
  fraction,
  color,
}: {
  fraction: number
  color: string
}) {
  return (
    <div
      className="absolute inset-x-0 bottom-0 h-1.5 overflow-hidden"
      style={{ background: 'transparent' }}
      aria-hidden="true"
    >
      <div
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`,
          height: '100%',
          background: color,
          opacity: 0.35,
        }}
      />
    </div>
  )
}

export function PointBoxes({ result, top, topLabel }: PointBoxesProps) {
  const items: ItemDef[] = [
    {
      key: 'play',
      name: '播放得点',
      color: COLOR.play,
      value: result.points.play,
      overlayColor: COLOR.play,
    },
    {
      key: 'interaction',
      name: '互动得点',
      color: COLOR.vib,
      value: result.points.interaction,
      overlayColor: COLOR.vib,
    },
    {
      key: 'favorite',
      name: '收藏得点',
      color: COLOR.fav,
      value: result.points.favorite,
      overlayColor: COLOR.fav,
    },
    {
      key: 'coin',
      name: '硬币得点',
      color: COLOR.coin,
      value: result.points.coin,
      overlayColor: COLOR.coin,
    },
    {
      key: 'like',
      name: '点赞得点',
      color: COLOR.like,
      value: result.points.like,
      overlayColor: '#555555',
    },
  ]

  return (
    <div>
      <SectionLabel note={top ? `叠加层 = √(本视频 / ${topLabel ?? 'Top 1'})` : undefined}>
        得点明细
      </SectionLabel>

      {/* 五类得点并列（乘的哪个修正、上限多少，由右侧「完整计算逻辑」区说明） */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {items.map((it) => (
          <div key={it.key} className="relative overflow-hidden border border-ink px-2.5 py-2.5">
            <div className="text-[12px] leading-tight">{it.name}</div>
            <div className="nums text-[26px] leading-none mt-2" style={{ color: it.color }}>
              {nf.format(round0(it.value))}
            </div>
            {top ? (
              <OverlayStrip
                fraction={overlayProgress(it.value, top[it.key])}
                color={it.overlayColor}
              />
            ) : null}
          </div>
        ))}
      </div>

      {/* 合计 */}
      <div className="mt-2 border border-ink px-2.5 py-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[11px] tracking-[0.1em] text-muted uppercase">最终得点</span>
        <span className="nums text-[32px] leading-none font-bold" style={{ color: 'var(--color-total)' }}>
          {nf.format(round0(result.total))}
        </span>
      </div>

      {top ? (
        <p className="text-[10px] text-muted mt-1.5 mb-0 leading-[1.6]">
          叠加层为对数刻度、不显示具体数值，仅表示与 {topLabel ?? 'Top 1'} 的相对位置。
        </p>
      ) : null}
    </div>
  )
}
