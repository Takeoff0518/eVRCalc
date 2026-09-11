/**
 * 进度条刻度算法的单元测试
 */

import { describe, expect, it } from 'vitest'
import { logScale, overlayProgress, ratioProgress, toPercent } from './scale'

describe('logScale（决策 1：对数刻度）', () => {
  it('ratio = 1 → 100%', () => {
    expect(logScale(1)).toBe(1)
  })

  it('跨越量程时落在预期位置', () => {
    // 量程 4 个数量级
    expect(logScale(0.1)).toBeCloseTo(0.75, 10)
    expect(logScale(0.01)).toBeCloseTo(0.5, 10)
    expect(logScale(0.001)).toBeCloseTo(0.25, 10)
    expect(logScale(0.0001)).toBeCloseTo(0, 10)
  })

  it('非正数或非有限值返回 0', () => {
    expect(logScale(0)).toBe(0)
    expect(logScale(-1)).toBe(0)
    expect(logScale(Number.NaN)).toBe(0)
    expect(logScale(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('大于 1 时钳制到 1', () => {
    expect(logScale(2)).toBe(1)
  })
})

describe('overlayProgress（draft: sqrt(本视频 / Top1) + 对数刻度）', () => {
  it('与 Top1 持平时为 100%', () => {
    expect(overlayProgress(1000, 1000)).toBeCloseTo(1, 10)
  })

  it('为 Top1 的四分之一时，sqrt 后为 0.5 → 75%', () => {
    expect(overlayProgress(250, 1000)).toBeCloseTo(logScale(0.5), 10)
  })

  it('Top1 为 0 或缺失时返回 0（不产生 NaN）', () => {
    expect(overlayProgress(100, 0)).toBe(0)
    expect(overlayProgress(0, 100)).toBe(0)
    expect(overlayProgress(Number.NaN, 100)).toBe(0)
    expect(overlayProgress(100, Number.NaN)).toBe(0)
  })

  it('结果始终落在 [0, 1]', () => {
    for (const v of [0, 1, 10, 1000, 1e9]) {
      for (const t of [1, 100, 1e6]) {
        const p = overlayProgress(v, t)
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('ratioProgress 与 toPercent', () => {
  it('线性映射并钳制', () => {
    expect(ratioProgress(25, 50)).toBe(0.5)
    expect(ratioProgress(75, 50)).toBe(1)
    expect(ratioProgress(-1, 50)).toBe(0)
    expect(ratioProgress(1, 0)).toBe(0)
  })

  it('转百分比取整', () => {
    expect(toPercent(0.925)).toBe(93)
    expect(toPercent(1.5)).toBe(100)
    expect(toPercent(-0.1)).toBe(0)
  })
})
