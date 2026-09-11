/**
 * 周刊排名定位
 *
 * 决策 5：只使用最新一期数据。
 * 判定方式：把当前得点与榜单各条 point 比较，得出「会排在第几」。
 * 说明：main_rank 只有 30 条。
 */

import type { WeeklyPeriod } from '../types/weekly'
import { SectionLabel } from './ScoreViz'

const nf = new Intl.NumberFormat('en-US')

export interface WeeklyRankProps {
  period: WeeklyPeriod
  /** 当前计算的最终得点 */
  total: number
  /** 数据来自缓存时的时间戳（0 表示来自网络） */
  fromCache: boolean
  cachedAt: number
}

function formatCachedAt(ts: number): string {
  if (!ts) return '缓存'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function WeeklyRank({ period, total, fromCache, cachedAt }: WeeklyRankProps) {
  const main = period.main_rank ?? []
  const mainRanked = main.filter((v) => v.rank !== undefined && v.point > 0)

  // 「会排在第几」：得点严格大于某条 → 排在其前面
  const wouldRank = mainRanked.filter((v) => v.point > total).length + 1
  const inMainRank = wouldRank <= mainRanked.length

  const neighborAbove = wouldRank > 1 ? mainRanked[wouldRank - 2] : undefined
  const neighborBelow = wouldRank <= mainRanked.length ? mainRanked[wouldRank - 1] : undefined

  return (
    <div>
      <SectionLabel
        note={
          fromCache
            ? `缓存 · ${formatCachedAt(cachedAt)}`
            : `生成于 ${period.generate_time}`
        }
      >
        周刊排名定位
      </SectionLabel>

      <div className="border border-ink px-2.5 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[11px]">
            第 <span className="nums">{period.ranknum}</span> 期
          </span>
          <span className="text-[10px] text-muted">
            采集窗口 {period.collect_start_time} — {period.collect_end_time}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[11px]">当前得点</span>
          <span className="nums text-[15px]">{nf.format(Math.round(total))}</span>
          <span className="text-[11px]">大约位于</span>
          <span className="nums text-[15px]" style={{ color: inMainRank ? 'var(--color-ink)' : 'var(--color-muted)' }}>
            {inMainRank ? `第 ${wouldRank} 位` : `第 ${mainRanked.length} 位之后`}
          </span>
        </div>

        {wouldRank === 1 && mainRanked.length > 0 ? (
          <p className="text-[10px] mt-1.5 mb-0" style={{ color: 'var(--color-play)' }}>
            高于本期榜首，仅作为与榜单 Top 1 的对比参考。
          </p>
        ) : null}

        {/* 相邻两条作为坐标参考 */}
        {neighborAbove || neighborBelow ? (
          <div className="mt-2 border-t border-ink pt-2 flex flex-col gap-1">
            {neighborAbove ? (
              <div className="flex items-baseline gap-2 text-[10px]">
                <span className="nums text-muted w-8 shrink-0">↑{neighborAbove.rank}</span>
                <span className="nums shrink-0">{nf.format(neighborAbove.point)}</span>
                <span className="truncate text-muted">{neighborAbove.title}</span>
              </div>
            ) : null}
            {neighborBelow ? (
              <div className="flex items-baseline gap-2 text-[10px]">
                <span className="nums text-muted w-8 shrink-0">↓{neighborBelow.rank}</span>
                <span className="nums shrink-0">{nf.format(neighborBelow.point)}</span>
                <span className="truncate text-muted">{neighborBelow.title}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="text-[10px] text-muted mt-2 mb-0 leading-[1.6]">
          榜单主榜共 <span className="nums">{mainRanked.length}</span> 条可比对。
          官方 point 为采集窗口时点快照，与本工具实时数据存在约 0.1% 偏差。
        </p>
      </div>
    </div>
  )
}
