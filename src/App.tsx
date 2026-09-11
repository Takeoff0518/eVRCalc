/**
 * eVRCalc —— 周刊虚拟歌手中文曲排行榜 · 视频得分计算器
 *
 * 设计要点（见 plan.md）：
 * - 计算内核是纯客户端的，**永远不依赖网络**
 * - 联网只用于周刊相关功能：排名定位、Top1 叠加层
 * - 只获取最新一期周刊
 * - 六项数据由用户手动填写
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { calculateScore } from './calc/score'
import { fetchWeeklyInfo, fetchWeeklyLatest } from './lib/api'
import { loadPeriodWithCache } from './lib/cachedFetch'
import type { RawStats, WeeklyPeriod, WeeklyVideo } from './types/weekly'
import { StatsForm } from './components/StatsForm'
import { PointBoxes, type TopValues } from './components/PointBoxes'
import { CorrectionBoxes } from './components/CorrectionBoxes'
import { WeeklyRank } from './components/WeeklyRank'
import { FormulaPanel } from './components/FormulaPanel'
import { Notice, type NoticeKind } from './components/Notice'

const EMPTY_STATS: RawStats = {
  play: 0,
  like: 0,
  favorite: 0,
  coin: 0,
  comment: 0,
  danmaku: 0,
}

const GITHUB_URL = 'https://github.com/Takeoff0518/eVRCalc'

interface NoticeState {
  kind: NoticeKind
  text: string
}

export default function App() {
  const [stats, setStats] = useState<RawStats>(EMPTY_STATS)

  const [period, setPeriod] = useState<WeeklyPeriod | undefined>()
  const [periodFromCache, setPeriodFromCache] = useState(false)
  const [periodCachedAt, setPeriodCachedAt] = useState(0)
  const [periodLoading, setPeriodLoading] = useState(true)

  const [notice, setNotice] = useState<NoticeState | undefined>()

  const resultRef = useRef<HTMLDivElement | null>(null)

  const result = useMemo(() => calculateScore(stats), [stats])
  const hasAnyInput = useMemo(
    () => (Object.keys(stats) as (keyof RawStats)[]).some((k) => stats[k] > 0),
    [stats],
  )

  // ── 启动时加载最新一期（只一次，非阻塞） ────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { result: cached, error } = await loadPeriodWithCache<WeeklyPeriod>(
        fetchWeeklyLatest,
        fetchWeeklyInfo,
      )
      if (cancelled) return

      if (cached) {
        setPeriod(cached.data)
        setPeriodFromCache(cached.fromCache)
        setPeriodCachedAt(cached.cachedAt)
        if (cached.fromCache) {
          setNotice({
            kind: 'warn',
            text: `联网暂不可用，本次沿用 ${periodCachedAtLabel(cached.cachedAt)} 的缓存数据。计算功能不受影响。`,
          })
        }
      } else {
        setNotice({
          kind: 'warn',
          text: `周刊数据暂时取不到（${error ?? '未知原因'}），排名定位与叠加层不可用。手动填写与得点计算完全不受影响。`,
        })
      }
      setPeriodLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ── 计算按钮：滚动到结果区（结果本身是响应式实时计算的） ─────────
  const handleCalculate = useCallback(() => {
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const handleClear = useCallback(() => setStats(EMPTY_STATS), [])

  const topValues: TopValues | undefined = useMemo(() => {
    if (!period) return undefined
    const all = [...(period.main_rank ?? []), ...(period.second_rank ?? [])]
    if (all.length === 0) return undefined
    const top = all.reduce((best, v) => (v.point > best.point ? v : best), all[0])
    const s = calculateScore(top)
    return {
      play: s.points.play,
      interaction: s.points.interaction,
      favorite: s.points.favorite,
      coin: s.points.coin,
      like: s.points.like,
    }
  }, [period])

  const topVideo: WeeklyVideo | undefined = useMemo(() => {
    if (!period) return undefined
    const all = [...(period.main_rank ?? []), ...(period.second_rank ?? [])]
    if (all.length === 0) return undefined
    return all.reduce((best, v) => (v.point > best.point ? v : best), all[0])
  }, [period])

  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="mx-auto max-w-[1180px] px-3 sm:px-5 py-4 sm:py-6">
        {/* ── 标题（不做 header，只留极简站名一行） ── */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-ink pb-2 mb-3">
          <h1 className="text-[19px] leading-none tracking-[0.02em] m-0">
            eVRCalc
            <span className="text-[10px] text-muted ml-2 tracking-[0.1em]">
              周刊虚拟歌手中文曲排行榜 · 视频得分计算器
            </span>
          </h1>
          <span className="nums text-[10px] text-muted">
            {periodLoading
              ? '周刊数据加载中…'
              : period
                ? `第 ${period.ranknum} 期 · ${periodFromCache ? '缓存' : '在线'}`
                : '周刊数据不可用'}
          </span>
        </div>

        {notice ? (
          <div className="mb-3">
            <Notice kind={notice.kind} onDismiss={() => setNotice(undefined)}>
              {notice.text}
            </Notice>
          </div>
        ) : null}

        {/* ── 主体：左工具 / 右公式；窄屏时公式区下移 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_330px] gap-4 lg:gap-5">
          {/* 左栏 */}
          <div className="flex flex-col gap-4 min-w-0">
            <StatsForm
              stats={stats}
              onChange={(patch) => setStats((cur) => ({ ...cur, ...patch }))}
              onCalculate={handleCalculate}
              onClear={handleClear}
            />

            <div ref={resultRef}>
              {hasAnyInput ? (
                <PointBoxes
                  result={result}
                  top={topValues}
                  topLabel={period && topVideo ? `第 ${period.ranknum} 期 Top 1` : undefined}
                />
              ) : (
                <div className="border border-ink px-2.5 py-6 text-center text-[11px] text-muted">
                  填写上方任意数据后自动显示得点明细
                </div>
              )}
            </div>

            {hasAnyInput ? <CorrectionBoxes result={result} /> : null}

            {period ? (
              <WeeklyRank
                period={period}
                total={result.total}
                fromCache={periodFromCache}
                cachedAt={periodCachedAt}
              />
            ) : null}
          </div>

          {/* 右栏 */}
          <aside className="min-w-0">
            <FormulaPanel result={hasAnyInput ? result : undefined} />
          </aside>
        </div>

        {/* ── footer ── */}
        <footer className="mt-6 border-t border-ink pt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] text-muted">eVRCalc · 数据来源：evocalrank</span>
          {GITHUB_URL ? (
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[10px] underline"
            >
              GitHub
            </a>
          ) : null}
        </footer>
      </div>
    </div>
  )
}

function periodCachedAtLabel(ts: number): string {
  if (!ts) return '上次'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
