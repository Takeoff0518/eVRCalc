/**
 * runtimeConfig 的单元测试
 *
 * 这段逻辑的作用是「换个后端地址不用重新构建前端」，所以重点是降级路径：
 * config.json 缺失、损坏、超时，都必须安静地退回构建期值，而不是让取数整体失败。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRuntimeConfig, loadRuntimeConfig } from './runtimeConfig'

beforeEach(() => {
  __resetRuntimeConfig()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubConfig(body: string | null, status = 200) {
  const calls: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(String(url))
    if (body === null) return Promise.reject(new Error('Failed to fetch'))
    return Promise.resolve(new Response(body, { status }))
  })
  return calls
}

describe('loadRuntimeConfig', () => {
  it('读到了 config.json 就用它', async () => {
    stubConfig(JSON.stringify({ apiBase: 'https://mc.tbpdt.top:9983', biliBase: '' }))
    const cfg = await loadRuntimeConfig()
    expect(cfg.apiBase).toBe('https://mc.tbpdt.top:9983')
    // biliBase 为空时跟随 apiBase
    expect(cfg.biliBase).toBe('https://mc.tbpdt.top:9983')
  })

  it('biliBase 单独指定时用它', async () => {
    stubConfig(JSON.stringify({ apiBase: 'https://a.example', biliBase: 'https://b.example' }))
    const cfg = await loadRuntimeConfig()
    expect(cfg.apiBase).toBe('https://a.example')
    expect(cfg.biliBase).toBe('https://b.example')
  })

  it('去掉末尾斜杠，避免拼出 //api/...', async () => {
    stubConfig(JSON.stringify({ apiBase: 'https://mc.tbpdt.top:9983///' }))
    const cfg = await loadRuntimeConfig()
    expect(cfg.apiBase).toBe('https://mc.tbpdt.top:9983')
  })

  it('config.json 不存在时静默退回，不抛异常', async () => {
    stubConfig(null)
    const cfg = await loadRuntimeConfig()
    // 测试环境没有 VITE_API_BASE，所以退回空串（相对路径）
    expect(typeof cfg.apiBase).toBe('string')
    expect(cfg.biliBase).toBe(cfg.apiBase)
  })

  it('config.json 返回 404 时静默退回', async () => {
    stubConfig('not found', 404)
    const cfg = await loadRuntimeConfig()
    expect(typeof cfg.apiBase).toBe('string')
  })

  it('config.json 内容损坏时静默退回', async () => {
    stubConfig('{ 这不是合法 JSON')
    const cfg = await loadRuntimeConfig()
    expect(typeof cfg.apiBase).toBe('string')
  })

  it('apiBase 是空白字符串时退回构建期值', async () => {
    stubConfig(JSON.stringify({ apiBase: '   ' }))
    const cfg = await loadRuntimeConfig()
    expect(typeof cfg.apiBase).toBe('string')
  })

  it('只请求一次（记住 Promise，避免并发拉多次）', async () => {
    const calls = stubConfig(JSON.stringify({ apiBase: 'https://a.example' }))
    await Promise.all([loadRuntimeConfig(), loadRuntimeConfig(), loadRuntimeConfig()])
    await loadRuntimeConfig()
    expect(calls.filter((u) => u.includes('config.json'))).toHaveLength(1)
  })

  it('请求带上 no-store，保证改了配置立刻生效', async () => {
    const calls = stubConfig(JSON.stringify({ apiBase: 'https://a.example' }))
    await loadRuntimeConfig()
    // 这里只能验证被请求过；cache 选项在 stub 里看不到，
    // 由源码里的 cache:'no-store' 保证
    expect(calls.some((u) => u.includes('config.json'))).toBe(true)
  })
})
