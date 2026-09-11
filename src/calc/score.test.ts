/**
 * 得点计算内核的单元测试
 */

import { describe, expect, it } from 'vitest'
import { calculateScore, normalizeStats, round2 } from './score'
import type { FormulaBranchKey } from './score'

const base = { play: 0, like: 0, favorite: 0, coin: 0, comment: 0, danmaku: 0 }

describe('normalizeStats', () => {
  it('空输入归零', () => {
    expect(normalizeStats(undefined)).toEqual(base)
    expect(normalizeStats(null)).toEqual(base)
    expect(normalizeStats({})).toEqual(base)
  })

  it('负数与 NaN 归零，小数取整', () => {
    expect(normalizeStats({ play: -5, like: NaN, coin: 3.9 })).toEqual({
      ...base,
      play: 0,
      like: 0,
      coin: 3,
    })
  })

  it('接受字符串数字', () => {
    expect(normalizeStats({ play: '1234' as unknown as number }).play).toBe(1234)
  })
})

describe('播放分档', () => {
  it('播放 <= 10000 → 基础播放得点 = 播放', () => {
    const r = calculateScore({ ...base, play: 10000, favorite: 100, coin: 100 })
    expect(r.playBranch).toBe('le')
    expect(r.basePlay).toBe(10000)
  })

  it('播放 > 10000 → 基础播放得点 = 播放 * 0.5 + 5000', () => {
    const r = calculateScore({ ...base, play: 10001, favorite: 100, coin: 100 })
    expect(r.playBranch).toBe('gt')
    expect(r.basePlay).toBeCloseTo(10001 * 0.5 + 5000, 10)
  })
})

describe('点赞得点上限', () => {
  it('点赞 > 硬币 * 2 → 硬币 * 2', () => {
    const r = calculateScore({ ...base, play: 100000, like: 1000, coin: 100, favorite: 100 })
    expect(r.points.like).toBe(200)
  })

  it('点赞 <= 硬币 * 2 → 点赞', () => {
    const r = calculateScore({ ...base, play: 100000, like: 150, coin: 100, favorite: 100 })
    expect(r.points.like).toBe(150)
  })
})

describe('修正值上限（抑制刷数据）', () => {
  it('修正 B 命中上限 50 时标记 capped', () => {
    // 硬币极小、收藏极大 → 收藏 > 硬币*2 分支，coin^2/(play*fav)*1000 很小
    // 用另一路径：收藏 <= 硬币*2 分支下 favorite/play*250 超过 50
    const r = calculateScore({ ...base, play: 1000, favorite: 400, coin: 400 })
    expect(r.corrections.b.capped).toBe(true)
    expect(r.corrections.b.value).toBe(50)
  })

  it('修正 C 命中上限 50 时标记 capped', () => {
    const r = calculateScore({ ...base, play: 1000, favorite: 400, coin: 300 })
    expect(r.corrections.c.capped).toBe(true)
    expect(r.corrections.c.value).toBe(50)
  })

  it('修正 D 命中上限 1 时标记 capped', () => {
    const r = calculateScore({ ...base, play: 1000, favorite: 400, coin: 400 })
    // D = favorite/play*25 = 10 > 1
    expect(r.corrections.d.capped).toBe(true)
    expect(r.corrections.d.value).toBe(1)
  })

  it('修正 A 永不超过 1', () => {
    const r = calculateScore({ ...base, play: 1e6, favorite: 1e6, coin: 1e6 })
    expect(r.corrections.a.value).toBeLessThanOrEqual(1)
    expect(r.corrections.a.capped).toBe(false)
  })
})

describe('除零与退化输入', () => {
  it('播放为 0 时 B/C/D 全取 0，不产生 NaN', () => {
    const r = calculateScore({ ...base, play: 0, favorite: 100, coin: 50, like: 10, comment: 1 })
    expect(r.degenerate).toBe(true)
    expect(r.corrections.b.value).toBe(0)
    expect(r.corrections.c.value).toBe(0)
    expect(r.corrections.d.value).toBe(0)
    expect(r.points.play).toBe(0)
    expect(Number.isFinite(r.total)).toBe(true)
  })

  it('全零输入得 0 分且无 NaN', () => {
    const r = calculateScore(base)
    expect(r.total).toBe(0)
    expect(Number.isFinite(r.total)).toBe(true)
  })

  it('收藏为 0 但硬币 > 0 时不产生 NaN', () => {
    const r = calculateScore({ ...base, play: 100000, favorite: 0, coin: 500 })
    expect(Number.isFinite(r.points.favorite)).toBe(true)
    expect(Number.isFinite(r.points.coin)).toBe(true)
  })
})

describe('合计关系', () => {
  it('最终得点 = 五类得点之和', () => {
    const r = calculateScore({
      play: 586808,
      like: 191808,
      favorite: 98134,
      coin: 41886,
      comment: 5323,
      danmaku: 5170,
    })
    const sum =
      r.points.play + r.points.interaction + r.points.favorite + r.points.coin + r.points.like
    expect(r.total).toBeCloseTo(sum, 8)
  })

  it('互动得点 = (评论 + 弹幕) * 修正 A * 15', () => {
    const r = calculateScore({ ...base, play: 500000, comment: 1000, danmaku: 500, favorite: 5000, coin: 3000 })
    expect(r.interactionCount).toBe(1500)
    expect(r.points.interaction).toBeCloseTo(1500 * r.corrections.a.value * 15, 8)
  })
})

describe('activeBranches（用于高亮右侧公式区被选中的选项）', () => {
  it('播放 <= 10000 时选中 basePlay.le，且不含 basePlay.gt', () => {
    const r = calculateScore({ ...base, play: 5000, favorite: 100, coin: 100 })
    expect(r.activeBranches.has('basePlay.le')).toBe(true)
    expect(r.activeBranches.has('basePlay.gt')).toBe(false)
  })

  it('播放 > 10000 时选中 basePlay.gt', () => {
    const r = calculateScore({ ...base, play: 50000, favorite: 100, coin: 100 })
    expect(r.activeBranches.has('basePlay.gt')).toBe(true)
    expect(r.activeBranches.has('basePlay.le')).toBe(false)
  })

  it('点赞超限时选中 like.capped', () => {
    const r = calculateScore({ ...base, play: 100000, like: 1000, coin: 100, favorite: 100 })
    expect(r.activeBranches.has('like.capped')).toBe(true)
    expect(r.activeBranches.has('like.normal')).toBe(false)
  })

  it('点赞未超限时选中 like.normal', () => {
    const r = calculateScore({ ...base, play: 100000, like: 100, coin: 100, favorite: 100 })
    expect(r.activeBranches.has('like.normal')).toBe(true)
    expect(r.activeBranches.has('like.capped')).toBe(false)
  })

  it('每组条件恰好选中一个（共 5 组）', () => {
    const r = calculateScore({
      play: 293866,
      like: 26586,
      favorite: 14678,
      coin: 21349,
      comment: 4493,
      danmaku: 1207,
    })
    expect(r.activeBranches.size).toBe(5)

    const groups: FormulaBranchKey[][] = [
      ['basePlay.gt', 'basePlay.le'],
      ['like.capped', 'like.normal'],
      ['corrB.high', 'corrB.low'],
      ['corrC.high', 'corrC.low'],
      ['corrD.high', 'corrD.low'],
    ]
    for (const g of groups) {
      expect(g.filter((k) => r.activeBranches.has(k))).toHaveLength(1)
    }
  })

  it('修正 A 无分支：formulaKey 为 null，且不参与高亮', () => {
    const r = calculateScore({ ...base, play: 100000, favorite: 100, coin: 100 })
    expect(r.corrections.a.formulaKey).toBeNull()
    // 不应有任何 corrA 相关的 key 出现在枚举中
    expect([...r.activeBranches].some((k) => k.startsWith('corrA'))).toBe(false)
  })

  it('命中上限与分支正交：cap 不改变被选中的分支', () => {
    // 收藏 400 / 硬币 400 / 播放 1000：
    //   B 走 low 分支（400 <= 800），值 100 > 50 → capped
    //   C 走 low 分支（400 <= 400），值 100 > 50 → capped
    //   D 走 low 分支（400 <= 400），值 10  > 1  → capped
    const r = calculateScore({ ...base, play: 1000, favorite: 400, coin: 400 })
    expect(r.corrections.b.capped).toBe(true)
    expect(r.corrections.c.capped).toBe(true)
    expect(r.corrections.d.capped).toBe(true)

    expect(r.corrections.b.formulaKey).toBe('corrB.low')
    expect(r.corrections.c.formulaKey).toBe('corrC.low')
    expect(r.corrections.d.formulaKey).toBe('corrD.low')

    // 三个 branch key 依然只有一个被选中
    expect(r.activeBranches.has('corrB.low')).toBe(true)
    expect(r.activeBranches.has('corrB.high')).toBe(false)
  })

  it('高分支 + 命中上限可以同时成立', () => {
    // 收藏 300000 > 硬币 1000 * 2 → B 走 high 分支
    //   值 = (1000^2 / (10 * 300000)) * 1000 = 333.33 > 50 → capped
    const r = calculateScore({ ...base, play: 10, favorite: 300000, coin: 1000 })
    expect(r.corrections.b.highBranch).toBe(true)
    expect(r.corrections.b.formulaKey).toBe('corrB.high')
    expect(r.corrections.b.capped).toBe(true)
    expect(r.corrections.b.value).toBe(50)
  })

  it('播放为 0（退化）时仍标记分支，只是修正值静默取 0', () => {
    const r = calculateScore({ ...base, play: 0, favorite: 100, coin: 50 })
    expect(r.degenerate).toBe(true)
    // 分支照常命中（0 <= 200 → B 走 low；50 <= 100 → C 走 low；100 > 50 → D 走 high）
    expect(r.activeBranches.has('corrB.low')).toBe(true)
    expect(r.activeBranches.has('corrC.low')).toBe(true)
    expect(r.activeBranches.has('corrD.high')).toBe(true)
    expect(r.activeBranches.size).toBe(5)
    // 但值静默为 0
    expect(r.corrections.b.value).toBe(0)
    expect(r.corrections.c.value).toBe(0)
    expect(r.corrections.d.value).toBe(0)
  })
})

describe('round2', () => {
  it('四舍五入两位', () => {
    expect(round2(30.466478)).toBe(30.47)
    expect(round2(1.784485)).toBe(1.78)
    expect(round2(Number.NaN)).toBe(0)
  })
})
