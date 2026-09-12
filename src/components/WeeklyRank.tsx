/**
 * 周刊排名定位
 *
 * 重要：官方把榜单切成两段存放 —— `main_rank` 是第 1~30 名，
 * `second_rank` 是第 31~110 名。**两段合起来才是完整榜单**。
 * （早期版本只用了 `main_rank`，导致任何得分都被压在 30 名以内，是明确的 bug。）
 *
 * 仅使用最新一期数据。
 *
 * ── 布局说明（为什么长这样）──────────────────────────────────────
 * 早先的版本把相邻条目压成 10px 的小字、上下各两条，结果是「看不出自己在
 * 110 条里的位置感」。现在改成**锥形视野**：
 *
 *   · 名次与得点用等宽数字右对齐，形成清晰的纵向对照列
 *   · 前方 4 条 + 后方 3 条，字号提到 12.5px（与正文同级，可读）
 *   · 在「你」的位置插一条分隔线，把"谁在你前面、谁在你后面"一眼分开
 *   · 得点低于榜尾时不显示空表，而是改为展示末尾 3 条并写明情况
 */

import type { WeeklyVideo, WeeklyPeriod } from '../types/weekly'
import { SectionLabel } from './ScoreViz'

const nf = new Intl.NumberFormat('en-US')

/** 前方显示几条（名次更靠前 = 得点更高） */
const AHEAD = 4
/** 后方显示几条 */
const BEHIND = 3

export interface WeeklyRankProps {
  period: WeeklyPeriod
  /** 当前计算的最终得点 */
  total: number
  /** 数据来自缓存时的时间戳（0 表示来自网络） */
  fromCache: boolean
  cachedAt: number
  /**
   * 点击某条视频的「填入」时回调。
   * 不传则不显示按钮 —— 后端不可用时调用方会省略它。
   */
  onFill?: (video: WeeklyVideo) => void
  /** 正在取数的那条（用 avid 标识），用于把按钮切成「获取中…」 */
  fillingAvid?: string
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

/**
 * 单条榜单行：名次 / 得点 / 可点击标题 / 可选「填入」
 *
 * 名次与得点固定宽度右对齐，纵向对齐后很容易比较「差多少分」——
 * 这是这一区最实际的用途。
 */
function RankRow({
  rank,
  video,
  onFill,
  filling,
}: {
  rank: number
  video: WeeklyVideo
  onFill?: (video: WeeklyVideo) => void
  filling?: boolean
}) {
  // 「填入」按钮只在鼠标悬停这一行时出现，避免每行都挂一个按钮把榜单读成表格。
  // 正在取数的那行例外：必须一直可见，否则点了之后按钮消失、看不出在加载。
  const canFill = Boolean(onFill)
  return (
    <div className="group flex items-center gap-2.5 text-[12.5px] leading-[1.5]">
      <span className="nums text-muted w-8 shrink-0 text-right">{rank}</span>
      <span className="nums w-[76px] shrink-0 text-right">{nf.format(video.point)}</span>
      {video.url ? (
        <a
          href={video.url}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate underline decoration-dotted underline-offset-2 hover:decoration-solid"
          title={video.title}
        >
          {video.title}
        </a>
      ) : (
        <span className="truncate" title={video.title}>
          {video.title}
        </span>
      )}
      {canFill ? (
        <button
          type="button"
          disabled={filling}
          onClick={() => onFill?.(video)}
          title={`获取《${video.title}》的播放/点赞/收藏/硬币/评论/弹幕并填入`}
          className={`btn-flat-xs shrink-0 ml-auto ${
            filling ? 'btn-flat-xs-disabled opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
        >
          {filling ? '获取中' : '填入'}
        </button>
      ) : null}
    </div>
  )
}

/** 「你大约在这里」的分隔线 */
function YouAreHere({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5" aria-hidden="true">
      <span className="h-px flex-1" style={{ background: 'var(--color-total)' }} />
      <span className="text-[10px] shrink-0" style={{ color: 'var(--color-total)' }}>
        {label}
      </span>
      <span className="h-px flex-1" style={{ background: 'var(--color-total)' }} />
    </div>
  )
}

export function WeeklyRank({
  period,
  total,
  fromCache,
  cachedAt,
  onFill,
  fillingAvid,
}: WeeklyRankProps) {
  const ranked = combineRanks(period)

  // 「会排在第几」：得点严格大于某条 → 排在其前面
  const wouldRank = ranked.filter((v) => v.point > total).length + 1
  const inRank = wouldRank <= ranked.length
  const nearTop = wouldRank === 1 && ranked.length > 0

  // 锥形视野：以当前名次为中心。前方取名次更小（得点更高）的那几条。
  const aheadFrom = Math.max(0, wouldRank - 1 - AHEAD)
  const ahead = ranked.slice(aheadFrom, Math.max(0, wouldRank - 1)).reverse()
  const behind = inRank ? ranked.slice(wouldRank - 1, wouldRank - 1 + BEHIND) : []

  // 低于榜尾时给末尾几条做参照，而不是留一片空白
  const tail = !inRank ? ranked.slice(-BEHIND) : []
  const tailFrom = ranked.length - tail.length + 1

  const hasRows = ahead.length > 0 || behind.length > 0 || tail.length > 0

  return (
    <div>
      <SectionLabel
        note={fromCache ? `缓存 · ${formatCachedAt(cachedAt)}` : `生成于 ${period.generate_time}`}
      >
        周刊排名定位
      </SectionLabel>

      <div className="border border-ink px-3 py-2.5">
        {/* 期号与采集窗口 */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[11px]">
            第 <span className="nums font-bold">{period.ranknum}</span> 期
          </span>
          <span className="text-[10px] text-muted">
            采集窗口 {period.collect_start_time} — {period.collect_end_time}
          </span>
        </div>

        {/* 结论行：得点与名次并排放大，这是这一区最该被一眼看到的东西 */}
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <span className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">当前得点</span>
            <span className="nums text-[22px] leading-none">{nf.format(Math.round(total))}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">大约位于</span>
            <span
              className="nums text-[22px] leading-none"
              style={{ color: inRank ? 'var(--color-total)' : 'var(--color-muted)' }}
            >
              {inRank ? `第 ${wouldRank} 位` : `第 ${ranked.length} 位之后`}
            </span>
          </span>
        </div>

        {nearTop ? (
          <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--color-play)' }}>
            高于本期榜首，下方为其后的名次，仅作参照。
          </p>
        ) : null}

        {/* 锥形视野 */}
        {hasRows ? (
          <div className="mt-3 border-t border-ink pt-2.5 flex flex-col gap-[3px]">
            {ahead.map((v) => (
              <RankRow key={`a-${v.avid}`} rank={v.rank ?? 0} video={v} />
            ))}

            {inRank ? (
              <YouAreHere label={`你大约在这里 · 第 ${wouldRank} 位`} />
            ) : (
              <YouAreHere label={`低于第 ${ranked.length} 名 · 以下是榜尾`} />
            )}

            {inRank
              ? behind.map((v) => (
                  <RankRow
                    key={`b-${v.avid}`}
                    rank={v.rank ?? 0}
                    video={v}
                    onFill={onFill}
                    filling={Boolean(fillingAvid) && fillingAvid === v.avid}
                  />
                ))
              : tail.map((v, i) => (
                  <RankRow key={`t-${v.avid}`} rank={tailFrom + i} video={v} />
                ))}
          </div>
        ) : null}

        <p className="text-[10px] text-muted mt-3 mb-0 leading-[1.7]">
          榜单共 <span className="nums">{ranked.length}</span> 条（第 1–30 名为主榜，
          第 31 名以后为续榜）。点击标题跳转到视频。
          {onFill ? '点「填入」可获取该视频的实时数据并自动填进上方的输入框。' : ''}
        </p>
      </div>
    </div>
  )
}
