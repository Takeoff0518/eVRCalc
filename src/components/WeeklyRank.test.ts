/**
 * 周刊排名定位的单元测试
 *
 * 重点保护一个已修复的 bug：官方把榜单切成两段存放
 * （main_rank = 第 1~30 名，second_rank = 第 31~110 名），
 * 早期版本只用了 main_rank，导致任何得分都被压在 30 名以内。
 */

import { describe, expect, it } from 'vitest'
import { combineRanks } from './WeeklyRank'
import type { WeeklyPeriod, WeeklyVideo } from '../types/weekly'

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
