/**
 * 进度条刻度与 B 站标识解析的单元测试
 */

import { describe, expect, it } from 'vitest'
import { logScale, overlayProgress, ratioProgress, toPercent } from './scale'
import { avidToAid, avToBv, normalizeAvid, parseBiliRef } from '../lib/bili'

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

describe('parseBiliRef', () => {
  it('纯 BV 号', () => {
    expect(parseBiliRef('BV1WeZLBtEW1')).toMatchObject({ bvid: 'BV1WeZLBtEW1', kind: 'bvid' })
  })

  it('纯 av 号', () => {
    expect(parseBiliRef('av116067884077341')).toMatchObject({ aid: '116067884077341', kind: 'avid' })
    expect(parseBiliRef('AV116067884077341')).toMatchObject({ aid: '116067884077341' })
  })

  it('完整链接（BV）', () => {
    expect(parseBiliRef('https://www.bilibili.com/video/BV1WeZLBtEW1')).toMatchObject({
      bvid: 'BV1WeZLBtEW1',
      kind: 'url-bvid',
    })
  })

  it('带 query 与斜杠的链接', () => {
    expect(
      parseBiliRef('https://www.bilibili.com/video/BV1WeZLBtEW1/?spm_id_from=333.999&vd_source=abc'),
    ).toMatchObject({ bvid: 'BV1WeZLBtEW1' })
  })

  it('完整链接（av）', () => {
    expect(parseBiliRef('https://www.bilibili.com/video/av116067884077341/')).toMatchObject({
      aid: '116067884077341',
      kind: 'url-avid',
    })
  })

  it('移动端链接', () => {
    expect(parseBiliRef('https://m.bilibili.com/video/BV1WeZLBtEW1')).toMatchObject({
      bvid: 'BV1WeZLBtEW1',
    })
  })

  it('?bvid= 形式', () => {
    expect(parseBiliRef('https://www.bilibili.com/video/?bvid=BV1WeZLBtEW1')).toMatchObject({
      bvid: 'BV1WeZLBtEW1',
    })
  })

  it('b23.tv 短链标记为 shortlink', () => {
    expect(parseBiliRef('https://b23.tv/abcdefg').kind).toBe('shortlink')
  })

  it('无法识别时返回 invalid', () => {
    expect(parseBiliRef('随便写点什么').kind).toBe('invalid')
    expect(parseBiliRef('').kind).toBe('invalid')
  })
})

describe('avToBv（draft 提供的 Kotlin 算法移植）', () => {
  it('av2 → BV1xx411c7mD（官方文档给出的对照）', () => {
    expect(avToBv('2')).toBe('BV1xx411c7mD')
    expect(avToBv('av2')).toBe('BV1xx411c7mD')
  })

  it('输出形如 BV1 + 9 位', () => {
    for (const aid of ['1', '170001', '116067884077341']) {
      const bv = avToBv(aid)
      expect(bv).toMatch(/^BV1[0-9A-Za-z]{9}$/)
    }
  })

  it('非法输入返回空串，不抛异常', () => {
    expect(avToBv('abc')).toBe('')
    expect(avToBv('')).toBe('')
  })
})

describe('avid 辅助函数', () => {
  it('avidToAid 提取数字', () => {
    expect(avidToAid('av123')).toBe('123')
    expect(avidToAid('123')).toBeUndefined()
  })

  it('normalizeAvid 去掉 av 前缀', () => {
    expect(normalizeAvid('av123')).toBe('123')
    expect(normalizeAvid('123')).toBe('123')
    expect(normalizeAvid(undefined)).toBe('')
  })
})
