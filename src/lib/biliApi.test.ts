/**
 * biliApi 的单元测试
 *
 * 重点覆盖输入解析与取数的降级路径 —— 这些函数的铁律是「永不 throw」，
 * 所以失败分支比成功分支更值得测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchBiliStats, formatFetchedAt, resolveBiliInput } from '../lib/biliApi'
import { __resetRuntimeConfig } from '../lib/runtimeConfig'

beforeEach(() => {
  // 取数函数现在会先读运行时的 config.json（见 runtimeConfig.ts）。
  // 每个用例都重置一次，否则会记住上一个用例的 Promise。
  __resetRuntimeConfig()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 记下所有请求；config.json 单独应答，免得混进断言里 */
function trackFetch(apiResponse: () => Response | Promise<Response>) {
  const apiCalls: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const u = String(url)
    if (u.includes('config.json')) {
      return Promise.resolve(new Response(JSON.stringify({ apiBase: 'https://backend.test' }), { status: 200 }))
    }
    apiCalls.push(u)
    return Promise.resolve(apiResponse())
  })
  return apiCalls
}

describe('formatFetchedAt', () => {
  it('把 RFC3339 转成 月-日 时:分', () => {
    // 用本地时区构造，避免测试机时区不同导致断言漂移
    const d = new Date(2026, 8, 7, 14, 23, 5) // 2026-09-07 14:23:05 本地时间
    const out = formatFetchedAt(d.toISOString())
    expect(out).toBe('09-07 14:23')
  })

  it('补零到两位', () => {
    const d = new Date(2026, 0, 3, 9, 5)
    expect(formatFetchedAt(d.toISOString())).toBe('01-03 09:05')
  })

  it('非法输入返回空串，不抛异常', () => {
    expect(formatFetchedAt('')).toBe('')
    expect(formatFetchedAt('垃圾数据')).toBe('')
  })
})

describe('fetchBiliStats', () => {
  function stubFetch(body: unknown, status = 200) {
    return trackFetch(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    )
  }

  const sample = {
    bvid: 'BV1mKto6kEBQ',
    aid: 117207459697071,
    title: '测试曲目',
    fetchedAt: '2026-09-07T06:23:05Z',
    cache: 'fresh',
    play: 516949,
    like: 40466,
    favorite: 23475,
    coin: 30738,
    comment: 5452,
    danmaku: 3234,
  }

  it('传 aid 时用 aid 参数', async () => {
    const calls = stubFetch(sample)
    const res = await fetchBiliStats({ aid: 'av117207459697071' })
    expect(res.ok).toBe(true)
    expect(calls[0]).toContain('aid=av117207459697071')
    expect(calls[0]).not.toContain('bvid=')
  })

  it('传 bvid 时用 bvid 参数', async () => {
    const calls = stubFetch(sample)
    await fetchBiliStats({ bvid: 'BV1mKto6kEBQ' })
    expect(calls[0]).toContain('bvid=BV1mKto6kEBQ')
  })

  it('bvid 优先于 aid', async () => {
    const calls = stubFetch(sample)
    await fetchBiliStats({ bvid: 'BV1mKto6kEBQ', aid: '117207459697071' })
    expect(calls[0]).toContain('bvid=')
    expect(calls[0]).not.toContain('aid=')
  })

  it('两者都空时直接失败，不发请求', async () => {
    const calls = stubFetch(sample)
    const res = await fetchBiliStats({})
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('HTTP 错误转成 { ok:false }，不抛异常', async () => {
    stubFetch({ error: '上游炸了' }, 502)
    const res = await fetchBiliStats({ bvid: 'BV1mKto6kEBQ' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('502')
  })

  it('网络异常也转成 { ok:false }', async () => {
    trackFetch(() => Promise.reject(new Error('Failed to fetch')) as never)
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('config.json')) {
        return Promise.resolve(new Response(JSON.stringify({ apiBase: 'https://backend.test' }), { status: 200 }))
      }
      return Promise.reject(new Error('Failed to fetch'))
    })
    const res = await fetchBiliStats({ bvid: 'BV1mKto6kEBQ' })
    expect(res.ok).toBe(false)
  })
})

describe('resolveBiliInput', () => {
  it('空输入直接失败，不发请求', async () => {
    const calls = trackFetch(() => new Response('{}'))
    const res = await resolveBiliInput('   ')
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('把输入编码进 q 参数', async () => {
    const calls = trackFetch(
      () =>
        new Response(JSON.stringify({ raw: '', bvid: 'BV1mKto6kEBQ', kind: 'url-bvid' }), {
          status: 200,
        }),
    )
    const res = await resolveBiliInput('https://www.bilibili.com/video/BV1mKto6kEBQ/?a=1&b=2')
    expect(res.ok).toBe(true)
    // & 与 ? 必须被编码，否则会被当成两个查询参数
    expect(calls[0]).toContain('q=https%3A%2F%2Fwww.bilibili.com')
    expect(calls[0]).not.toContain('&b=2')
  })
})
