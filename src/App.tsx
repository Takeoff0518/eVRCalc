/**
 * eVRCalc —— 周刊虚拟歌手中文曲排行榜 · 视频得分计算器
 *
 * 设计要点（见 plan.md）：
 * - 计算内核是纯客户端的，**永远不依赖网络**（决策 4）
 * - 联网只用于三项增强：B 站自动填充、周刊排名定位、Top1 叠加层
 * - 只获取最新一期周刊（决策 5）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { calculateScore, normalizeStats } from './calc/score'
import { fetchBiliView, fetchWeeklyInfo, fetchWeeklyLatest } from './lib/api'
import { loadPeriodWithCache } from './lib/cachedFetch'
import { avToBv, normalizeAvid, parseBiliRef } from './lib/bili'
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
  const [biliInput, setBiliInput] = useState('')

  const [apiAvailable, setApiAvailable] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [video, setVideo] = useState<{ id: string; title: string; cover?: string } | undefined>()
  const [queryMessage, setQueryMessage] = useState<{ kind: NoticeKind; text: string } | undefined>()

  const [period, setPeriod] = useState<WeeklyPeriod | undefined>()
  const [periodFromCache, setPeriodFromCache] = useState(false)
  const [periodCachedAt, setPeriodCachedAt] = useState(0)
  const [periodLoading, setPeriodLoading] = useState(true)

  const [notice, setNotice] = useState<NoticeState | undefined>()

  const resultRef = useRef<HTMLDivElement | null>(null)
  const subtractRef = useRef<RawStats | null>(null)
  const [subtractAvailable, setSubtractAvailable] = useState(false)

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
        setApiAvailable(!cached.fromCache)
        if (cached.fromCache) {
          setNotice({
            kind: 'warn',
            text: `联网代理暂时不可用，本次沿用 ${periodCachedAtLabel(cached.cachedAt)} 的缓存数据。计算功能不受影响。`,
          })
        }
      } else {
        setApiAvailable(false)
        setNotice({
          kind: 'warn',
          text: `联网代理不可用（${error ?? '未知原因'}），自动填充与周刊排名暂不可用。请手动填写数据，计算功能完全不受影响。`,
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

  // ── 查询 B 站数据 ──────────────────────────────────────────────
  const handleQuery = useCallback(async () => {
    const ref = parseBiliRef(biliInput)
    setQueryMessage(undefined)

    if (ref.kind === 'invalid') {
      setQueryMessage({ kind: 'error', text: '无法识别输入，请填写 B 站视频链接、BV 号或 av 号。' })
      return
    }
    if (ref.kind === 'shortlink') {
      setQueryMessage({
        kind: 'warn',
        text: 'b23.tv 短链需要先展开，请改用完整链接或直接填写 BV 号 / av 号。',
      })
      return
    }

    setQuerying(true)
    try {
      const res = await fetchBiliView({ bvid: ref.bvid, aid: ref.aid })
      if (!res.ok) {
        setQueryMessage({ kind: 'error', text: `查询失败：${res.error}。你仍可手动填写数据。` })
        return
      }

      const d = res.data
      const st = d.stat ?? {}
      const fetched = normalizeStats({
        play: st.view,
        like: st.like,
        favorite: st.favorite,
        coin: st.coin,
        comment: st.reply,
        danmaku: st.danmaku,
      })

      setStats(fetched)
      setVideo({
        id: d.bvid || ref.bvid || `av${ref.aid ?? ''}`,
        title: d.title || '（无标题）',
        cover: d.pic,
      })

      // 是否在最新一期榜单中 → 提供「减去上期数据」按钮
      const matched = period ? findInPeriod(period, d.bvid, d.aid, ref.bvid, ref.aid) : undefined
      if (matched) {
        subtractRef.current = normalizeStats(matched)
        setSubtractAvailable(true)
        setQueryMessage({
          kind: 'info',
          text: `已填入实时数据。该视频也在第 ${period!.ranknum} 期榜单中，可减去其数据得到本期增量。`,
        })
      } else {
        subtractRef.current = null
        setSubtractAvailable(false)
        setQueryMessage({ kind: 'info', text: '已填入实时数据。' })
      }
    } finally {
      setQuerying(false)
    }
  }, [biliInput, period])

  // ── 清空数据 ───────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setStats(EMPTY_STATS)
    setBiliInput('')
    setVideo(undefined)
    setQueryMessage(undefined)
    subtractRef.current = null
    setSubtractAvailable(false)
  }, [])

  // ── 减去上期数据 ───────────────────────────────────────────────
  const handleSubtract = useCallback(() => {
    const prev = subtractRef.current
    if (!prev) return
    setStats((cur) => {
      const next: RawStats = { ...EMPTY_STATS }
      for (const k of Object.keys(EMPTY_STATS) as (keyof RawStats)[]) {
        next[k] = Math.max(0, cur[k] - prev[k])
      }
      return next
    })
    setQueryMessage({ kind: 'info', text: '已减去榜单中该视频的数据。' })
  }, [])

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
            {' · '}
            自动填充{apiAvailable ? '可用' : '不可用'}
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
              biliInput={biliInput}
              onBiliInputChange={setBiliInput}
              onQuery={() => void handleQuery()}
              onCalculate={handleCalculate}
              onClear={handleClear}
              apiAvailable={apiAvailable}
              querying={querying}
              videoTitle={video?.title}
              videoCover={video?.cover}
              videoId={video?.id}
              canSubtract={subtractAvailable}
              subtractLabel={period ? `减去第 ${period.ranknum} 期数据` : '减去上期数据'}
              onSubtract={handleSubtract}
              queryMessage={queryMessage}
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
          <span className="text-[10px] text-muted">
            eVRCalc · 数据来源：bilibili · evocalrank
          </span>
          {GITHUB_URL ? (
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[10px] underline"
            >
              GitHub
            </a>
          ) : (
            <span className="text-[10px] text-muted">GitHub（待填）</span>
          )}
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

/** 在期刊中按 avid / bvid / aid 查找视频 */
function findInPeriod(
  period: WeeklyPeriod,
  bvid: string | undefined,
  aid: number | undefined,
  fallbackBvid: string | undefined,
  fallbackAid: string | undefined,
): WeeklyVideo | undefined {
  const pools: WeeklyVideo[][] = [
    period.main_rank ?? [],
    period.second_rank ?? [],
    period.pick_up ?? [],
    period.super_hit ?? [],
  ]
  const all = pools.flat()

  const targetAids = new Set<string>()
  const targetBvids = new Set<string>()

  if (aid !== undefined) targetAids.add(String(aid))
  if (fallbackAid) targetAids.add(String(fallbackAid))
  if (bvid) targetBvids.add(bvid.toUpperCase())
  if (fallbackBvid) targetBvids.add(fallbackBvid.toUpperCase())

  // 用 av 号反推 BV 号，提高匹配率（榜单只给 av 号）
  for (const a of targetAids) targetBvids.add(avToBv(a).toUpperCase())

  return all.find((v) => {
    const vid = normalizeAvid(v.avid)
    if (vid && targetAids.has(vid)) return true
    const fromAv = avToBv(vid).toUpperCase()
    if (fromAv && targetBvids.has(fromAv)) return true
    return false
  })
}
