/**
 * 取数层
 *
 * 铁律（plan.md §4 决策 4）：**永不 throw，永不阻塞首屏**。
 * - 统一返回 { ok, data?, error? }，调用方永远不需要 try/catch
 * - 5 秒超时，不自动重试
 * - Worker 未上线时，本模块的所有调用都会快速失败，界面据此静默降级
 */

import type { InfoJson, WeeklyPeriod } from '../types/weekly'

export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string }

const DEFAULT_TIMEOUT = 5000

/**
 * API 基地址。
 *
 * 前端部署在 GitHub Pages（evrc.tbpdt.top），后端跑在家里那台机器上
 * （Go 服务，形如 mc.tbpdt.top:9983），两者**跨域**。
 *
 * 地址的解析顺序见 `runtimeConfig.ts`：先读站点根目录的 `config.json`
 * （运行时可改，不必重新构建），取不到再退回构建期的 `VITE_API_BASE`，
 * 最后才是相对路径（本地开发由 Vite proxy 转发）。
 *
 * 注意协议必须与页面一致：页面在 https 下时，浏览器会**硬拦**跨域的
 * http 请求（混合内容），所以后端必须自己启用 HTTPS。
 */

import { loadRuntimeConfig } from './runtimeConfig'

async function apiUrl(path: string): Promise<string> {
  const { apiBase } = await loadRuntimeConfig()
  return `${apiBase}${path}`
}

/** 带超时的 fetch，天然不抛异常 */
export async function fetchJson<T>(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<FetchResult<T>> {
  if (typeof fetch !== 'function') {
    return { ok: false, error: '当前环境不支持 fetch' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as T
    return { ok: true, data }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e?.name === 'AbortError') return { ok: false, error: '请求超时' }
    return { ok: false, error: e?.message ?? '网络请求失败' }
  } finally {
    clearTimeout(timer)
  }
}

// ── 周刊接口 ─────────────────────────────────────────────────────

/** 期数目录（含最新期号） */
export async function fetchWeeklyInfo(): Promise<FetchResult<InfoJson>> {
  return fetchJson<InfoJson>(await apiUrl('/api/weekly/info'))
}

/**
 * 最新一期数据。
 * 决策 5：本工具只获取最新一期，它同时充当排名定位、Top1 叠加、
 * 「减去上期数据」三项功能的基准（见 plan.md §0 说明）。
 */
export async function fetchWeeklyLatest(): Promise<FetchResult<WeeklyPeriod>> {
  return fetchJson<WeeklyPeriod>(await apiUrl('/api/weekly/latest'))
}

/** 特定期数数据（本版本默认不用，保留给将来切换） */
export async function fetchWeeklyRank(n: number | string): Promise<FetchResult<WeeklyPeriod>> {
  return fetchJson<WeeklyPeriod>(await apiUrl(`/api/weekly/rank?n=${encodeURIComponent(String(n))}`))
}
