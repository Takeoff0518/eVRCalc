/**
 * 周刊排名定位
 *
 * 重要：官方把榜单切成两段存放 —— `main_rank` 是第 1~30 名，
 * `second_rank` 是第 31~110 名。**两段合起来才是完整榜单**。
 * （早期版本只用了 `main_rank`，导致任何得分都被压在 30 名以内，是明确的 bug。）
 *
 * 仅使用最新一期数据。
 */

import type { WeeklyVideo, WeeklyPeriod } from '../types/weekly'
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

/** 合并主榜与续榜，按名次升序；名次缺失时用数组位置兜底 */
export function combineRanks(period: WeeklyPeriod): WeeklyVideo[] {
  const main = (period.main_rank ?? []).map((v, i) => ({ v, fallback: i + 1 }))
  const second = (period.second_rank ?? []).map((v, i) => ({ v, fallback: main.length + i + 1 }))
  return [...main, ...second]
    .map(({ v, fallback }) => ({ video: v, rank: v.rank ?? fallback }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.video)
}

/** 单条参考行：名次 / 得点 / 可点击标题 */
function RankRefRow({
  rank,
  video,
  muted,
}: {
  rank: number
  video: WeeklyVideo
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2 text-[10px]">
      <span className="nums text-muted w-10 shrink-0 text-right">{rank}</span>
      <span className="nums shrink-0">{nf.format(video.point)}</span>
      {video.url ? (
        <a
          href={video.url}
          target="_blank"
          rel="noreferrer noopener"
          className={`truncate underline decoration-dotted underline-offset-2 hover:decoration-solid ${muted ? 'text-muted' : ''}`}
          title={video.title}
        >
          {video.title}
        </a>
      ) : (
        <span className={`truncate ${muted ? 'text-muted' : ''}`} title={video.title}>
          {video.title}
        </span>
      )}
    </div>
  )
}

export function WeeklyRank({ period, total, fromCache, cachedAt }: WeeklyRankProps) {
  const ranked = combineRanks(period)

  // 「会排在第几」：得点严格大于某条 → 排在其前面
  const wouldRank = ranked.filter((v) => v.point > total).length + 1
  const inRank = wouldRank <= ranked.length

  // 上下相邻各显示两条，便于判断差距
  const above = ranked.slice(Math.max(0, wouldRank - 3), wouldRank - 1).reverse()
  const below = ranked.slice(wouldRank - 1, wouldRank + 1)
  const nearTop = wouldRank === 1 && ranked.length > 0

  return (
    <div>
      <SectionLabel
        note={fromCache ? `缓存 · ${formatCachedAt(cachedAt)}` : `生成于 ${period.generate_time}`}
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
          <span
            className="nums text-[15px]"
            style={{ color: inRank ? 'var(--color-ink)' : 'var(--color-muted)' }}
          >
            {inRank ? `第 ${wouldRank} 位` : `第 ${ranked.length} 位之后`}
          </span>
        </div>

        {nearTop ? (
          <p className="text-[10px] mt-1.5 mb-0" style={{ color: 'var(--color-play)' }}>
            高于本期榜首，仅作为与榜单 Top 1 的对比参考。
          </p>
        ) : null}

        {/* 相邻名次作为坐标参考 */}
        {above.length || below.length ? (
          <div className="mt-2 border-t border-ink pt-2 flex flex-col gap-1">
            {above.map((v, i) => (
              <RankRefRow
                key={`a-${v.avid}`}
                rank={Math.max(1, wouldRank - 2 + i)}
                video={v}
                muted
              />
            ))}
            {below.map((v, i) => (
              <RankRefRow key={`b-${v.avid}`} rank={wouldRank + i} video={v} />
            ))}
          </div>
        ) : null}

        <p className="text-[10px] text-muted mt-2 mb-0 leading-[1.6]">
          榜单共 <span className="nums">{ranked.length}</span> 条可比对（第 1–30 名为主榜，
          第 31 名以后为续榜）。点击标题可跳转到对应视频。
          <br />
          官方 point 为采集窗口时点快照，与本工具实时数据存在约 0.1% 偏差。
        </p>
      </div>
    </div>
  )
}
