/**
 * 周刊排名定位的单元测试
 *
 * 保护三类东西：
 *   1. 一个已修复的 bug —— 官方把榜单切成两段存放（main_rank = 第 1~30 名，
 *      second_rank = 第 31~110 名），早期只用了 main_rank，
 *      导致任何得分都被压在 30 名以内。
 *   2. 占位行（「你大约在这里」）的位置 —— 这一段边界错得最多，
 *      而且错得很难用肉眼发现，必须逐行断言。
 *   3. 「高于榜首 / 低于榜尾」两种边界视图。
 *
 * 渲染方式用 renderToStaticMarkup（react-dom/server）而不是 jsdom：
 * 只关心输出里有哪些行、值是什么，不需要真实 DOM 与事件模拟。
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WeeklyRank, combineRanks } from './WeeklyRank'
import type { WeeklyPeriod, WeeklyVideo } from '../types/weekly'
import latestFixture from '../__fixtures__/latest-735.json'

// ── 行解析 ────────────────────────────────────────────────────────
//
// 踩过的坑（别再走一遍）：
//   1. 「按行容器切分 + 取第一个 span」→ 命中的是**名次**列而不是得点
//   2. 「先取所有得点、再取所有名次、按索引配对」→ 两条正则覆盖面不一致
//      （带 style 的占位行会被其中一条漏掉），数量对不上
//   3. 复用带 g 标志的正则 → lastIndex 残留，第二次匹配从上次结束处开始
//
// 现在：**一次匹配整行**（名次列 + 得点列一起），三个捕获组天然同属一行；
// 每次都新建正则。若改了列宽（w-8 / w-[76px]），这里要同步。

const ROW = /class="nums text-muted w-8 shrink-0 text-right"[^>]*>(\d+|—)<\/span><span class="nums w-\[76px\] shrink-0 text-right"[^>]*>([\d,]+)</g

interface ParsedRow {
  /** 名次列的内容：数字，或占位行在没有名次时的「—」 */
  rank: number | null
  point: number
  isYou: boolean
}

/** 只取榜单那一段（跳过期号、结论行与页脚） */
function rankSection(html: string): string {
  const start = html.indexOf('mt-3 border-t border-ink')
  return start >= 0 ? html.slice(start) : html
}

/**
 * 解析榜单行。
 *
 * 占位行靠「你大约在这里」这几个字判定，不依赖名次列的写法 ——
 * 这样名次列无论渲染成数字还是「—」都能正确识别。
 */
function rowsWithYou(html: string): ParsedRow[] {
  const section = rankSection(html)
  const rows: (ParsedRow & { pos: number })[] = []
  for (const m of section.matchAll(new RegExp(ROW.source, 'g'))) {
    const pos = m.index ?? 0
    // 占位行的标题列是「你大约在这里」；看这一行往后一小段内有没有它
    const isYou = section.slice(pos, pos + 400).includes('你大约在这里')
    rows.push({
      rank: m[1] === '—' ? null : Number(m[1]),
      point: Number(m[2].replace(/,/g, '')),
      isYou,
      pos,
    })
  }
  return rows.sort((a, b) => a.pos - b.pos)
}

/** 渲染后取出行标签序列，如 ['1','2','YOU','3'] */
function order(period: WeeklyPeriod, total: number): string[] {
  const html = renderToStaticMarkup(
    <WeeklyRank period={period} total={total} fromCache={false} cachedAt={0} />,
  )
  return rowsWithYou(html).map((r) => (r.isYou ? 'YOU' : String(r.rank)))
}

// ── 合成数据 ──────────────────────────────────────────────────────

function makeVideo(rank: number, point: number): WeeklyVideo {
  return {
    url: `https://www.bilibili.com/video/av${100000 + rank}/`,
    avid: `av${100000 + rank}`,
    title: `第 ${rank} 名`,
    pubdate: '2026-08-30 08:00:00',
    point,
    play: point,
    coin: 0,
    comment: 0,
    danmaku: 0,
    favorite: 0,
    like: 0,
    rank,
  }
}

/** 构造一份 110 条的期刊：主榜 1~30，续榜 31~110 */
function makePeriod(): WeeklyPeriod {
  const main = Array.from({ length: 30 }, (_, i) => makeVideo(i + 1, 1_000_000 - i * 1000))
  const second = Array.from({ length: 80 }, (_, i) => makeVideo(31 + i, 900_000 - i * 1000))
  return {
    version: 1.2,
    ranknum: 735,
    url: '',
    coverurl: '',
    pubdate: '',
    generate_time: '2026-09-07 11:25:17',
    generate_timestamp: 0,
    collect_start_time: '2026年8月29日 3:00',
    collect_end_time: '2026年9月5日 3:00',
    collect_start_time_timestamp: 0,
    collect_end_time_timestamp: 0,
    main_rank: main,
    second_rank: second,
  } as WeeklyPeriod
}

describe('combineRanks', () => {
  it('合并主榜与续榜，共 110 条', () => {
    expect(combineRanks(makePeriod())).toHaveLength(110)
  })

  it('名次连续覆盖 1~110', () => {
    const ranks = combineRanks(makePeriod()).map((v) => v.rank)
    expect(ranks[0]).toBe(1)
    expect(ranks[109]).toBe(110)
    expect(new Set(ranks).size).toBe(110)
  })

  it('按名次升序排列', () => {
    const ranks = combineRanks(makePeriod()).map((v) => v.rank ?? 0)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1])
    }
  })

  it('缺 second_rank 时退化为仅主榜，不抛异常', () => {
    const p = { ...makePeriod(), second_rank: undefined } as WeeklyPeriod
    expect(combineRanks(p)).toHaveLength(30)
  })

  it('两条数组都缺时返回空数组', () => {
    const p = { ...makePeriod(), main_rank: [], second_rank: [] } as WeeklyPeriod
    expect(combineRanks(p)).toEqual([])
  })

  it('rank 缺失时用数组位置兜底，且兜底值确实写进返回值', () => {
    // 这里曾经有个 bug：兜底算出的 rank 只用于排序，返回时又被丢掉，
    // 调用方拿到的仍是 undefined（界面靠 `v.rank ?? 0` 掩盖了它）。
    const p = {
      ...makePeriod(),
      main_rank: [{ ...makeVideo(1, 500), rank: undefined }, makeVideo(9, 400)],
      second_rank: [],
    } as unknown as WeeklyPeriod
    const out = combineRanks(p)
    expect(out[0].rank).toBe(1) // 缺失 → 用第 1 个位置兜底
    expect(out[1].rank).toBe(9) // 有值 → 保留原值
    // 全库范围也应当没有 undefined
    expect(combineRanks(makePeriod()).every((v) => typeof v.rank === 'number')).toBe(true)
  })
})

describe('排名定位逻辑（原先被 30 名上限截断的场景）', () => {
  const ranked = () => combineRanks(makePeriod())

  /** 与组件内一致的判定方式 */
  const wouldRank = (total: number) => ranked().filter((v) => v.point > total).length + 1

  it('比榜首还高 → 第 1 位', () => {
    expect(wouldRank(2_000_000)).toBe(1)
  })

  it('落在主榜内 → 名次正确', () => {
    expect(wouldRank(996_500)).toBe(5)
  })

  it('落在续榜区间 → 能算出超过 30 的名次（修复前会被截断在 31）', () => {
    const rank = wouldRank(900_500)
    expect(rank).toBe(31)
    expect(rank).toBeGreaterThan(30)
  })

  it('落在续榜深处 → 名次接近 110', () => {
    expect(wouldRank(821_500)).toBe(110)
  })

  it('低于榜尾 → 超出可比较范围', () => {
    const r = wouldRank(1000)
    expect(r).toBe(111)
    expect(r).toBeGreaterThan(ranked().length)
  })
})

/**
 * 完整 110 条榜单下的占位位置。
 *
 * 为什么单独做一组：仓库里的 latest-735.json 是**抽样夹具**（只到第 40 名），
 * 拿它测不出靠近榜尾的边界。而这里恰恰出过 bug —— `behind` 的起点差了 ±1，
 * 占位行被插到第 107/108 名之间而不是第 108/109 名之间。
 */
describe('完整 110 条榜单下的占位位置', () => {
  const period = makePeriod()

  /** 得点略高于第 rank 名 → wouldRank 就应当是 rank */
  const totalForRank = (rank: number) => {
    const v = combineRanks(period).find((x) => x.rank === rank)!
    return v.point + 1
  }

  it('夹具本身是 110 条', () => {
    expect(combineRanks(period)).toHaveLength(110)
  })

  it('靠近榜首：占位行在第 1 名之前', () => {
    expect(order(period, totalForRank(1))).toEqual(['YOU', '1', '2', '3'])
  })

  it('第 5 名：前后各若干条，名次升序', () => {
    expect(order(period, totalForRank(5))).toEqual(['1', '2', '3', '4', 'YOU', '5', '6', '7'])
  })

  it('主榜与续榜交界（第 30/31 名）', () => {
    expect(order(period, totalForRank(30))).toEqual(['26', '27', '28', '29', 'YOU', '30', '31', '32'])
    expect(order(period, totalForRank(31))).toEqual(['27', '28', '29', '30', 'YOU', '31', '32', '33'])
  })

  it('第 107 名', () => {
    expect(order(period, totalForRank(107))).toEqual(['103', '104', '105', '106', 'YOU', '107', '108', '109'])
  })

  it('第 108 名', () => {
    expect(order(period, totalForRank(108))).toEqual(['104', '105', '106', '107', 'YOU', '108', '109', '110'])
  })

  // ↓ 这条正是被报上来的 bug：占位行曾被插到 107 与 108 之间
  it('第 109 名：占位行必须在第 108 名之后、第 109 名之前', () => {
    expect(order(period, totalForRank(109))).toEqual(['105', '106', '107', '108', 'YOU', '109', '110'])
  })

  it('第 110 名（榜尾）', () => {
    expect(order(period, totalForRank(110))).toEqual(['106', '107', '108', '109', 'YOU', '110'])
  })

  it('低于榜尾：占位行在最后，前方是紧邻榜尾的 AHEAD 条', () => {
    // 得点 1 分 → 低于全部 110 条。参照条目应当是榜单末尾那几条
    // （早期实现这里混进了「榜尾之前」与「榜尾」两批，导致重复渲染）
    expect(order(period, 1)).toEqual(['107', '108', '109', '110', 'YOU'])
  })

  it('兜底校验：占位行恰好一个，且名次不重复', () => {
    for (const rank of [1, 5, 30, 31, 55, 105, 108, 109, 110]) {
      const rows = order(period, totalForRank(rank))
      expect(rows.filter((r) => r === 'YOU')).toHaveLength(1)
      const ranks = rows.filter((r) => r !== 'YOU')
      expect(new Set(ranks).size).toBe(ranks.length)
    }
  })
})

/**
 * 结论行与文案。
 *
 * 「大约位于第 N 位」是这一区最该被一眼看到的信息 —— 只靠占位行的位置去推断
 * 很容易读错（实测把第 108 位读成了「第 110 名之后」）。
 */
describe('结论行与文案', () => {
  const period = makePeriod()

  const render = (total: number) =>
    renderToStaticMarkup(
      <WeeklyRank period={period} total={total} fromCache={false} cachedAt={0} />,
    )

  it('在榜内时明确写出「第 N 位」', () => {
    expect(render(996_500)).toMatch(/大约位于<\/span><span[^>]*>第 5 位</)
  })

  it('高于榜首时写「第 1 位」，并给提示', () => {
    const html = render(2_000_000)
    expect(html).toMatch(/大约位于<\/span><span[^>]*>第 1 位</)
    expect(html).toContain('高于本期榜首')
  })

  it('低于榜尾时写「第 110 名之后」，而不是「第 110 位」', () => {
    const html = render(1)
    expect(html).toMatch(/大约位于<\/span><span[^>]*>第 110 名之后</)
    expect(html).toContain('当前得点低于第 110 名')
  })

  it('当前得点也一并显示，便于核对输入', () => {
    expect(render(12_345)).toContain('12,345')
  })

  it('不再出现「填入」按钮与相关提示', () => {
    const html = render(996_500)
    expect(html).not.toContain('填入')
    expect(html).not.toContain('可获取该视频的实时数据')
  })

  it('不再有横线式分隔（旧设计的残留）', () => {
    const html = render(996_500)
    expect(html).not.toContain('你大约在这里 · 第')
    expect(html).not.toContain('以下是榜尾')
  })
})

/**
 * 占位行的列内容。
 *
 * 名次列**一律是「—」**，不印真实名次：
 *   · 位置由上方「大约位于 第 N 位」给出，再印一遍是重复
 *   · 高于榜首（第 0 位）与低于榜尾（第 N+1 位）本来就没有名次，
 *     印数字会与第 1 名 / 第 N 名重号
 * 所以三种情况表现一致。
 */
describe('占位行', () => {
  const period = makePeriod()

  const youRow = (total: number) => {
    const html = renderToStaticMarkup(
      <WeeklyRank period={period} total={total} fromCache={false} cachedAt={0} />,
    )
    return rowsWithYou(html).find((r) => r.isYou)!
  }

  it('名次列一律是「—」—— 在榜内时也是', () => {
    expect(youRow(996_500).rank).toBeNull()
  })

  it('名次列一律是「—」—— 高于榜首时', () => {
    expect(youRow(2_000_000).rank).toBeNull()
  })

  it('名次列一律是「—」—— 低于榜尾时', () => {
    expect(youRow(1).rank).toBeNull()
  })

  it('数字列是当前得点', () => {
    expect(youRow(996_500).point).toBe(996_500)
  })

  it('整行用绿色（与普通条目区分）', () => {
    const html = renderToStaticMarkup(
      <WeeklyRank period={period} total={996_500} fromCache={false} cachedAt={0} />,
    )
    expect(html).toContain('var(--color-total)')
  })
})

/**
 * 真实夹具（latest-735.json，抽样到第 40 名）下的渲染护栏。
 */
describe('锥形视野（真实数据）', () => {
  const realPeriod = latestFixture as unknown as WeeklyPeriod

  const render = (total: number) =>
    renderToStaticMarkup(
      <WeeklyRank period={realPeriod} total={total} fromCache={false} cachedAt={0} />,
    )

  it('夹具可用', () => {
    expect(combineRanks(realPeriod).length).toBeGreaterThanOrEqual(30)
  })

  it('占位行前后各若干条，名次整体递增（占位行不打断顺序）', () => {
    const rows = rowsWithYou(render(200_000))
    expect(rows.filter((r) => r.isYou)).toHaveLength(1)
    const ranks = rows.filter((r) => !r.isYou).map((r) => r.rank!)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1])
    }
  })

  it('占位行的得点介于上下两行之间', () => {
    const rows = rowsWithYou(render(200_000))
    const i = rows.findIndex((r) => r.isYou)
    expect(rows[i].point).toBe(200_000)
    expect(rows[i].point).toBeLessThan(rows[i - 1].point)
    expect(rows[i].point).toBeGreaterThan(rows[i + 1].point)
  })

  it('低于榜尾时参照条目取自榜单末尾，且占位行在最后', () => {
    const rows = rowsWithYou(render(1104))
    const all = combineRanks(realPeriod)
    expect(rows[rows.length - 1].isYou).toBe(true)
    // 参照条目应当是榜单最后一条为止
    expect(rows[rows.length - 2].point).toBe(all[all.length - 1].point)
  })

  it('名次与得点用等宽数字列，宽度固定以便纵向对齐', () => {
    const html = render(200_000)
    expect(html).toContain('w-8 shrink-0 text-right')
    expect(html).toContain('w-[76px] shrink-0 text-right')
  })
})
