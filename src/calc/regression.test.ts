/**
 * 真实数据回归测试
 *
 * 夹具为从官网抓取的真实数据（六期 main_rank，共 180 条）。
 * 断言本工具的计算结果与官方发布的 point 之间的相对偏差。
 *
 * 实测平均偏差 0.0699%、最差 0.5051%，且越老的期偏差越大。
 * 成因尚未定论，因此这里只把它当作**回归护栏**（阈值 1%），
 * 不对偏差来源下结论 —— 避免把推测写成事实。
 */

import { describe, expect, it } from 'vitest'
import { calculateScore } from './score'
import type { RawStats } from '../types/weekly'

import p735 from '../__fixtures__/period-735.json'
import p734 from '../__fixtures__/period-734.json'
import p733 from '../__fixtures__/period-733.json'
import p730 from '../__fixtures__/period-730.json'
import p700 from '../__fixtures__/period-700.json'
import p650 from '../__fixtures__/period-650.json'
import latestFixture from '../__fixtures__/latest-735.json'

interface FixtureEntry extends RawStats {
  avid: string
  title: string
  rank: number
  point: number
}

interface Fixture {
  ranknum: number
  entries: FixtureEntry[]
}

const PERIODS: Fixture[] = [p735, p734, p733, p730, p700, p650] as unknown as Fixture[]
const MAX_RELATIVE_DEVIATION = 0.01 // 1%

function relativeDeviation(entry: FixtureEntry): number {
  const calc = calculateScore(entry).total
  return Math.abs(calc - entry.point) / entry.point
}

describe('真实数据回归（官网六期 main_rank）', () => {
  it('夹具完整加载', () => {
    expect(PERIODS).toHaveLength(6)
    const total = PERIODS.reduce((n, p) => n + p.entries.length, 0)
    expect(total).toBeGreaterThanOrEqual(150)
    for (const p of PERIODS) {
      expect(p.ranknum).toBeGreaterThan(0)
      expect(p.entries.length).toBeGreaterThan(0)
    }
  })

  for (const period of PERIODS) {
    it(`第 ${period.ranknum} 期：全部条目相对偏差 < ${MAX_RELATIVE_DEVIATION * 100}%`, () => {
      const worst = period.entries.reduce(
        (acc, e) => {
          const d = relativeDeviation(e)
          return d > acc.d ? { d, e } : acc
        },
        { d: 0, e: period.entries[0] },
      )
      // 失败时打印最差的一条，便于定位
      expect(
        worst.d,
        `最差条目 ${worst.e.avid} 官方 ${worst.e.point} vs 本工具 ${Math.round(
          calculateScore(worst.e).total,
        )}`,
      ).toBeLessThan(MAX_RELATIVE_DEVIATION)
    })
  }

  it('全部 180 条的平均相对偏差 < 0.2%', () => {
    const all = PERIODS.flatMap((p) => p.entries)
    const mean = all.reduce((sum, e) => sum + relativeDeviation(e), 0) / all.length
    expect(mean).toBeLessThan(0.002)
  })

  it('组合计算不产生 NaN / Infinity', () => {
    for (const period of PERIODS) {
      for (const e of period.entries) {
        const r = calculateScore(e)
        expect(Number.isFinite(r.total)).toBe(true)
        expect(r.total).toBeGreaterThan(0)
      }
    }
  })
})

describe('latest.json 夹具（周刊排名定位数据源）', () => {
  it('期号与主榜条目存在', () => {
    const f = latestFixture as unknown as { ranknum: number; main_rank: FixtureEntry[] }
    expect(f.ranknum).toBe(735)
    expect(f.main_rank.length).toBe(30)
  })

  it('主榜按得点降序（可用于排名定位）', () => {
    const f = latestFixture as unknown as { main_rank: FixtureEntry[] }
    for (let i = 1; i < f.main_rank.length; i++) {
      expect(f.main_rank[i - 1].point).toBeGreaterThanOrEqual(f.main_rank[i].point)
    }
  })

  it('主榜每条都能算出有限得点（叠加层基准可用）', () => {
    const f = latestFixture as unknown as { main_rank: FixtureEntry[] }
    for (const e of f.main_rank) {
      const r = calculateScore(e)
      expect(Number.isFinite(r.total)).toBe(true)
      // 五类得点都必须是有限数，否则叠加层 sqrt 会出 NaN
      for (const v of Object.values(r.points)) {
        expect(Number.isFinite(v)).toBe(true)
      }
    }
  })
})

describe('端到端：官网第 730 期榜首（对照 draft 的样例数据）', () => {
  // draft.md 中给出的实例：point = 4187245
  const top = {
    play: 586808,
    coin: 41886,
    comment: 5323,
    danmaku: 5170,
    favorite: 98134,
    like: 191808,
  }

  it('结果与官方 point 的偏差 < 0.05%', () => {
    const r = calculateScore(top)
    const deviation = Math.abs(r.total - 4187245) / 4187245
    expect(deviation).toBeLessThan(0.0005)
  })

  it('五类得点均大于 0，且直播放分支为「超过 10000」', () => {
    const r = calculateScore(top)
    expect(r.playBranch).toBe('gt')
    for (const v of Object.values(r.points)) {
      expect(v).toBeGreaterThan(0)
    }
  })

  it('修正值落在各自上限之内', () => {
    const r = calculateScore(top)
    expect(r.corrections.a.value).toBeLessThanOrEqual(1)
    expect(r.corrections.b.value).toBeLessThanOrEqual(50)
    expect(r.corrections.c.value).toBeLessThanOrEqual(50)
    expect(r.corrections.d.value).toBeLessThanOrEqual(1)
  })
})
