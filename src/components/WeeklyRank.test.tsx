/**
 * 周刊排名定位的单元测试
 *
 * 重点保护一个已修复的 bug：官方把榜单切成两段存放
 * （main_rank = 第 1~30 名，second_rank = 第 31~110 名），
 * 早期版本只用了 main_rank，导致任何得分都被压在 30 名以内。
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WeeklyRank, combineRanks } from './WeeklyRank'
import type { WeeklyPeriod, WeeklyVideo } from '../types/weekly'
import latestFixture from '../__fixtures__/latest-735.json'

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
    const points = combineRanks(makePeriod()).map((v) => v.point)
    for (let i = 1; i < points.length; i++) {
      expect(points[i - 1]).toBeGreaterThanOrEqual(points[i])
    }
  })

  it('缺 second_rank 时退化为仅主榜，不抛异常', () => {
    const p = { ...makePeriod(), second_rank: undefined } as WeeklyPeriod
    expect(combineRanks(p)).toHaveLength(30)
  })

  it('两条数组都缺时返回空数组', () => {
    const p = { ...makePeriod(), main_rank: undefined, second_rank: undefined } as unknown as WeeklyPeriod
    expect(combineRanks(p)).toHaveLength(0)
  })

  it('rank 字段缺失时用数组位置兜底（按得点排序仍然正确）', () => {
    const p = makePeriod()
    const noRank = (p.main_rank as (WeeklyVideo & { rank?: number })[]).map((v) => {
      const { rank: _drop, ...rest } = v as WeeklyVideo & { rank?: number }
      return rest as WeeklyVideo
    })
    const merged = combineRanks({ ...p, main_rank: noRank } as WeeklyPeriod)
    expect(merged).toHaveLength(110)
    // combineRanks 返回原始 video 对象（rank 已被剥掉），因此只能断言排序结果：
    // 兜底名次 1..30 的得点是递减的，应排在续榜之前
    expect(merged[0].point).toBe(1_000_000)
    expect(merged[29].point).toBe(1_000_000 - 29 * 1000)
    expect(merged[30].point).toBe(900_000)
    expect(merged[109].point).toBe(900_000 - 79 * 1000)
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
    // 主榜第 5 名得点 = 1_000_000 - 4*1000 = 996000
    expect(wouldRank(996_500)).toBe(5)
  })

  it('落在续榜区间 → 能算出超过 30 的名次（修复前会被截断在 31）', () => {
    // 续榜第 1 条（总第 31 名）得点 = 900000
    const rank = wouldRank(900_500)
    expect(rank).toBe(31)
    expect(rank).toBeGreaterThan(30)
  })

  it('落在续榜深处 → 名次接近 110', () => {
    // 续榜最后一条（总第 110 名）得点 = 900000 - 79*1000 = 821000
    expect(wouldRank(821_500)).toBe(110)
  })

  it('低于榜尾 → 超出可比较范围', () => {
    const r = wouldRank(1000)
    expect(r).toBe(111)
    expect(r).toBeGreaterThan(ranked().length)
  })
})

/**
 * 「填入」按钮与锥形视野的渲染测试。
 *
 * 用 renderToStaticMarkup（react-dom/server）而不是 jsdom：
 * 只关心输出里有没有按钮、在哪几行，不需要真实 DOM 与事件模拟，
 * 也就不必为此引入 jsdom 与 testing-library。
 *
 * 注意：按钮用 group-hover 控制显隐，**DOM 里始终存在**（只是透明），
 * 所以这里数按钮数量仍然有效；显隐由 CSS 负责，无需断言。
 */
describe('「填入」按钮', () => {
  const render = (total: number, onFill?: (v: WeeklyVideo) => void) =>
    renderToStaticMarkup(
      <WeeklyRank period={makePeriod()} total={total} fromCache={false} cachedAt={0} onFill={onFill} />,
    )

  const countFill = (html: string) => (html.match(/>填入</g) ?? []).length

  it('不传 onFill 时一个按钮都不渲染（后端不可用时的降级）', () => {
    const html = render(996_500)
    expect(countFill(html)).toBe(0)
    expect(html).not.toContain('可获取该视频的实时数据')
  })

  it('传了 onFill 时，当前名次及其后共 3 条各有一个按钮', () => {
    // 得点 996500 → 第 5 位；后方显示第 5、6、7 名
    const html = render(996_500, () => {})
    expect(countFill(html)).toBe(3)
    expect(html).toContain('可获取该视频的实时数据')
  })

  it('前方的行不带按钮（只用于看差距）', () => {
    // 第 5 位 → 前方第 1~4 名共 4 行，后方第 5~7 名共 3 行
    const html = render(996_500, () => {})
    const rowCount = (html.match(/group flex items-center gap-2\.5/g) ?? []).length
    expect(rowCount).toBe(7)
    expect(countFill(html)).toBe(3) // 只有后方的 3 行带按钮
  })

  it('比榜首还高 → 仍能填入后方的名次', () => {
    const html = render(2_000_000, () => {})
    expect(countFill(html)).toBe(3)
    expect(html).toContain('高于本期榜首')
  })

  it('低于榜尾 → 改为展示榜尾 3 条，且没有可填项', () => {
    const html = render(1000, () => {})
    expect(countFill(html)).toBe(0)
    expect(html).toContain('以下是榜尾')
    // 仍应显示提示，说明功能存在
    expect(html).toContain('可获取该视频的实时数据')
  })

  it('正在取数的那个条目显示「获取中」而不是「填入」', () => {
    const html = renderToStaticMarkup(
      <WeeklyRank
        period={makePeriod()}
        total={996_500}
        fromCache={false}
        cachedAt={0}
        onFill={() => {}}
        fillingAvid="av100005"
      />,
    )
    expect(html).toContain('>获取中<')
    expect(countFill(html)).toBe(2) // 另外两条仍是「填入」
  })
})

/**
 * 用**真实榜单数据**（夹具）验证锥形视野的渲染结果。
 *
 * 为什么不靠无头浏览器截图：那需要真实网络与异步时序，验证起来很不稳定；
 * SSR + 真实夹具既确定了输入，又能长期作为回归护栏。
 */
describe('锥形视野（真实数据）', () => {
  const realPeriod = latestFixture as unknown as WeeklyPeriod

  /**
   * 取出「分隔线之前 / 之后」两段。
   *
   * 列表顺序是**名次越高越靠前**（符合榜单阅读习惯），所以整体上名次并非
   * 单调：前方段是 6→5→4→3（往上名次更小），后方段是 7→8→9。
   * 断言必须按两段分别写，不能要求整段单调。
   */
  function splitAtSeparator(html: string) {
    const idx = html.search(/你大约在这里 · 第 \d+ 位|低于第 \d+ 名 · 以下是榜尾/)
    return { aheadPart: html.slice(0, idx), behindPart: html.slice(idx) }
  }

  /** 从一段 HTML 里按列取值；两个列一一对应，不对应就直接失败 */
  function rowsIn(fragment: string): { rank: number; point: number }[] {
    const ranks = [...fragment.matchAll(/class="nums text-muted w-8 shrink-0 text-right">(\d+)</g)].map((m) =>
      Number(m[1]),
    )
    const points = [...fragment.matchAll(/class="nums w-\[76px\] shrink-0 text-right">([\d,]+)</g)].map((m) =>
      Number(m[1].replace(/,/g, '')),
    )
    expect(points.length).toBe(ranks.length)
    return ranks.map((rank, i) => ({ rank, point: points[i] }))
  }

  function rowsOf(html: string): { rank: number; point: number }[] {
    const start = html.indexOf('mt-3 border-t border-ink')
    return rowsIn(start >= 0 ? html.slice(start) : html)
  }

  const render = (total: number) =>
    renderToStaticMarkup(
      <WeeklyRank period={realPeriod} total={total} fromCache={false} cachedAt={0} />,
    )

  it('夹具可用（抽样夹具，非完整 110 条）', () => {
    expect(combineRanks(realPeriod).length).toBeGreaterThanOrEqual(30)
  })

  it('前方 4 条 + 后方 3 条，共 7 行', () => {
    const rows = rowsOf(render(200_000))
    expect(rows).toHaveLength(7)
  })

  it('前方段：名次递减（往上名次更小），得点递增（越靠前分越高）', () => {
    const { aheadPart } = splitAtSeparator(render(200_000))
    const rows = rowsIn(aheadPart)
    expect(rows.length).toBe(4)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rank).toBeLessThan(rows[i - 1].rank)
      expect(rows[i].point).toBeGreaterThan(rows[i - 1].point)
    }
  })

  it('后方段：名次递增，得点递减', () => {
    const { behindPart } = splitAtSeparator(render(200_000))
    const rows = rowsIn(behindPart)
    expect(rows.length).toBe(3)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rank).toBeGreaterThan(rows[i - 1].rank)
      expect(rows[i].point).toBeLessThan(rows[i - 1].point)
    }
  })

  it('分隔线两侧的得点关系正确：前方全部高于后方', () => {
    const { aheadPart, behindPart } = splitAtSeparator(render(200_000))
    const ahead = rowsIn(aheadPart)
    const behind = rowsIn(behindPart)
    expect(Math.min(...ahead.map((r) => r.point))).toBeGreaterThan(
      Math.max(...behind.map((r) => r.point)),
    )
  })

  it('分隔线两侧的名次关系正确：前方全部小于后方', () => {
    const { aheadPart, behindPart } = splitAtSeparator(render(200_000))
    const ahead = rowsIn(aheadPart)
    const behind = rowsIn(behindPart)
    expect(Math.max(...ahead.map((r) => r.rank))).toBeLessThan(Math.min(...behind.map((r) => r.rank)))
  })

  it('分隔线标出的名次落在展示区间内', () => {
    const html = render(200_000)
    const m = html.match(/你大约在这里 · 第 (\d+) 位/)
    expect(m).not.toBeNull()
    const rank = Number(m![1])
    const rows = rowsOf(html)
    expect(rank).toBeGreaterThanOrEqual(Math.min(...rows.map((r) => r.rank)))
    expect(rank).toBeLessThanOrEqual(Math.max(...rows.map((r) => r.rank)))
  })

  it('得点高于榜首时从第 1 名开始，并提示高于榜首', () => {
    const html = render(99_999_999)
    expect(html).toContain('高于本期榜首')
    const rows = rowsOf(html)
    expect(rows[0].rank).toBe(1)
  })

  it('得点低于榜尾时切换为榜尾视图并写明情况', () => {
    const html = render(1)
    expect(html).toContain('以下是榜尾')
    const rows = rowsOf(html)
    const all = combineRanks(realPeriod)
    // 最后一行应当是榜单最后一名
    expect(rows[rows.length - 1].rank).toBe(all[all.length - 1].rank)
    // 且按名次降序展示（榜尾在最前，接上去是更靠前的名次）
    expect(rows[0].rank).toBeGreaterThan(rows[1].rank)
  })

  it('名次与得点用等宽数字列，宽度固定以便纵向对齐', () => {
    const html = render(200_000)
    expect(html).toContain('w-8 shrink-0 text-right')
    expect(html).toContain('w-[76px] shrink-0 text-right')
  })
})
