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
 * 当前所在位置**不用横线标出**，而是作为一行插进榜单里，与上下行完全同版式、
 * 同列宽，只是整行换成绿色：
 *
 *      65    19,880   ▸ 某曲目标题
 *      —     19,420   你大约在这里      ← 绿色
 *      66    19,050   ▸ 某曲目标题
 *
 * 用横线的版本有两个毛病，所以换掉了：
 *   · 版式不一致，眼睛要在两种表达之间切换
 *   · 排序方向的歧义无法消除 —— 榜单按名次升序排，于是横线之上是 65~68、
 *     之下是 69~71，按「上面更靠前」的直觉去读会觉得顺序是乱的。
 *     改成插入行之后，位置本身就说明了顺序，不必再解释
 * 名次列填「—」而不是数字，避免与真实名次混淆。
 */

import type { WeeklyVideo, WeeklyPeriod } from '../types/weekly'
import { SectionLabel } from './ScoreViz'

const nf = new Intl.NumberFormat('en-US')

/** 当前行**之前**显示几条（名次更小 = 得点更高） */
const AHEAD = 4
/** 当前行**之后**显示几条 */
const BEHIND = 3

/** 当前所在位置的整行颜色 */
const YOU_COLOR = 'var(--color-total)'

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

/**
 * 合并主榜与续榜，按名次升序；名次缺失时用数组位置兜底。
 *
 * 注意末尾那步 `{ ...x.video, rank: x.rank }` —— 早先直接返回 `x.video`，
 * 于是**兜底算出来的 rank 被丢掉了**（只参与了排序），返回值里的 rank 仍是
 * undefined。界面上因为到处写 `v.rank ?? 0` 而没暴露，但函数名承诺的
 * 「名次缺失时兜底」并没有兑现。
 */
export function combineRanks(period: WeeklyPeriod): WeeklyVideo[] {
  const main = (period.main_rank ?? []).map((v, i) => ({ v, fallback: i + 1 }))
  const second = (period.second_rank ?? []).map((v, i) => ({ v, fallback: main.length + i + 1 }))
  return [...main, ...second]
    .map(({ v, fallback }) => ({ video: v, rank: v.rank ?? fallback }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => ({ ...x.video, rank: x.rank }))
}

/**
 * 单条榜单行：名次 / 得点 / 标题。
 *
 * 名次与得点用固定宽度右对齐，纵向能直接比较「差多少分」——
 * 这是这一区最实际的用途。
 *
 * `youAreHere` 为真时渲染成绿色占位行：名次列一律是「—」，数字列是当前得点，
 * 标题列是「你大约在这里」。
 *
 * 名次列为什么**一律用「—」**而不是印上真实名次：
 *   · 位置已经由上方那行「大约位于 第 N 位」明确给出，再印一遍是重复
 *   · 而且并非所有情况都有名次 —— 高于榜首（第 0 位）与低于榜尾（第 N+1 位）
 *     本来就没有对应名次，印数字反而会与第 1 名 / 第 N 名重号
 * 所以统一「—」，三种情况表现一致，不需要用户去分辨「这里为什么有时是数字」。
 */
function RankRow({
  rank,
  video,
  youAreHere,
  total,
}: {
  rank: number | '—'
  video?: WeeklyVideo
  youAreHere?: boolean
  total?: number
}) {
  const tint = youAreHere ? { color: YOU_COLOR } : undefined

  return (
    <div className="flex items-center gap-2.5 text-[12.5px] leading-[1.5]">
      <span className="nums text-muted w-8 shrink-0 text-right" style={tint}>
        {youAreHere ? '—' : rank}
      </span>
      <span className="nums w-[76px] shrink-0 text-right" style={tint}>
        {nf.format(Math.round(youAreHere ? (total ?? 0) : (video?.point ?? 0)))}
      </span>
      {youAreHere ? (
        <span style={tint}>你大约在这里</span>
      ) : video?.url ? (
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
        <span className="truncate" title={video?.title}>
          {video?.title}
        </span>
      )}
    </div>
  )
}

export function WeeklyRank({ period, total, fromCache, cachedAt }: WeeklyRankProps) {
  const ranked = combineRanks(period)

  // 「会排在第几」：得点严格大于某条 → 排在其前面。
  // 注意它可能**超出榜单长度**（得点低于榜尾时 = N+1）。
  const wouldRank = ranked.filter((v) => v.point > total).length + 1
  const inRank = wouldRank <= ranked.length
  const nearTop = wouldRank === 1 && ranked.length > 0

  // ── 取哪几条 ───────────────────────────────────────────────────
  //
  // 这一段连续踩过三个坑，都留在注释里：
  //
  // 1) `wouldRank` 可能超出榜单长度。不能直接拿它当参照点，否则切片会落到
  //    榜单末尾那几条上，与「榜尾参照」重复渲染。所以先钳制。
  // 2) 区间长度容易算错：`ref - 1` 已是当前行的**下标**，再减 AHEAD 得到的是
  //    起点，长度就成了 AHEAD+1，多出的那条正好与 tail 重叠。
  // 3) **低于榜尾时该拿哪几条作参照**。早先取的是「榜单末尾 BEHIND 条」——
  //    但当得点远低于榜尾时（例如 1104 分对上游 12,881 分的榜尾），
  //    拿榜尾当参照毫无意义：差着十倍。合理的是取**紧邻它上方**的那几条，
  //    也就是榜单末尾往前推，让「差距」是有信息量的。
  //
  // 现在的取法（数组 0-indexed，ref = 当前行应插入的位置 = 当前名次）：
  //   · 在榜内：前方 ranked[ref-1-AHEAD .. ref-1)，后方 ranked[ref-1 .. ref-1+BEHIND)
  //   · 低于榜尾：占位行插在**榜单最末**（它低于所有条目），前方取末尾 AHEAD 条
  const ref = Math.min(wouldRank, ranked.length)

  const inList = inRank
  const aheadEnd = inList ? ref - 1 : ranked.length
  const ahead = ranked.slice(Math.max(0, aheadEnd - AHEAD), Math.max(0, aheadEnd))
  const behind = inList ? ranked.slice(ref - 1, ref - 1 + BEHIND) : []

  const hasRows = ahead.length > 0 || behind.length > 0

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
            {period.collect_start_time} — {period.collect_end_time}
          </span>
        </div>

        {/* 结论行：把「第几位」明确写出来，不必靠数行数推断 */}
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <span className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">当前得点</span>
            <span className="nums text-[20px] leading-none"
            style={{ color: YOU_COLOR }}
            >{nf.format(Math.round(total))}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted">大约位于</span>
            <span
              className="nums text-[20px] leading-none"
              style={{ color: inRank ? YOU_COLOR : 'var(--color-muted)' }}
            >
              {inRank ? `第 ${wouldRank} 位` : `第 ${ranked.length} 名之后`}
            </span>
          </span>
        </div>

        {nearTop ? (
          <p className="text-[11px] mt-2 mb-0" style={{ color: 'var(--color-play)' }}>
            高于本期榜首。
          </p>
        ) : null}

        {/* 榜单：当前所在位置作为一行插入，与上下行同版式 */}
        {hasRows ? (
          <div className="mt-3 border-t border-ink pt-2.5 flex flex-col gap-[3px]">
            {ahead.map((v) => (
              <RankRow key={`a-${v.avid}`} rank={v.rank ?? 0} video={v} />
            ))}

            {/* 占位行一律用「—」：位置由上方「大约位于 第 N 位」给出，
                这里再印名次就是重复；而且高于榜首 / 低于榜尾本来就没有名次 */}
            <RankRow rank="—" youAreHere total={total} />

            {behind.map((v) => (
              <RankRow key={`b-${v.avid}`} rank={v.rank ?? 0} video={v} />
            ))}
          </div>
        ) : null}

        <p className="text-[10px] text-muted mt-3 mb-0 leading-[1.7]">
          榜单共 <span className="nums">{ranked.length}</span> 条（第 1–30 名为主榜，第 31 名以后为副榜）。点击标题跳转到视频。
          {/* {!inRank ? `当前得点低于第 ${ranked.length} 名，上方为榜单末尾几条作参照。` : ''} */}
        </p>
      </div>
    </div>
  )
}
