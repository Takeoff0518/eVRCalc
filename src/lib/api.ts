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
 * 前端部署在 GitHub Pages（evrc.tbpdt.top），API 是 Cloudflare 上的另一个
 * 子域，两者**跨域**，所以生产构建时必须由 `VITE_API_BASE` 指定 Worker 地址；
 * 否则默认走相对路径（本地开发由 Vite proxy 转发，同源）。
 *
 * 例：VITE_API_BASE=https://api.tbpdt.top
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

function apiUrl(path: string): string {
  return `${API_BASE}${path}`
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
export function fetchWeeklyInfo(): Promise<FetchResult<InfoJson>> {
  return fetchJson<InfoJson>(apiUrl('/api/weekly/info'))
}

/**
 * 最新一期数据。
 * 决策 5：本工具只获取最新一期，它同时充当排名定位、Top1 叠加、
 * 「减去上期数据」三项功能的基准（见 plan.md §0 说明）。
 */
export function fetchWeeklyLatest(): Promise<FetchResult<WeeklyPeriod>> {
  return fetchJson<WeeklyPeriod>(apiUrl('/api/weekly/latest'))
}

/** 特定期数数据（本版本默认不用，保留给将来切换） */
export function fetchWeeklyRank(n: number | string): Promise<FetchResult<WeeklyPeriod>> {
  return fetchJson<WeeklyPeriod>(apiUrl(`/api/weekly/rank?n=${encodeURIComponent(String(n))}`))
}
