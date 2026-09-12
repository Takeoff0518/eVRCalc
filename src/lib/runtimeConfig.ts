/**
 * 运行时可配的 API 地址
 *
 * 为什么不在构建时写死（原先的做法）：`VITE_API_BASE` 是**构建期**变量，
 * 换个协议或端口就得改工作流 + 重新部署 Pages。而后端地址恰恰是最容易反复的一件事
 * （先是 http↔https，再是端口）。
 *
 * 现在的规则：
 *   1. 先试 `config.json`（部署在站点根目录，改它**立即生效**，不用重新构建）
 *   2. 取不到就退回构建期的 `VITE_API_BASE` / `VITE_BILI_BASE`
 *   3. 都没有则走相对路径（本地开发由 Vite proxy 转发）
 *
 * `public/config.json` 已入库，所以仓库本身就是"当前线上配置"的记录。
 *
 * 注意解析只做一次（记住 Promise），所有取数函数都等它 —— 避免出现
 * 一部分请求已经发出、配置却还没读到的竞态。
 */

/** config.json 的形状 */
export interface RuntimeConfig {
  /** 后端基地址，例：https://mc.tbpdt.top:9983 */
  apiBase?: string
  /** B 站接口基地址，缺省时跟随 apiBase */
  biliBase?: string
}

/** 构建期的兜底值 */
const BUILD_API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')
const BUILD_BILI_BASE = (import.meta.env.VITE_BILI_BASE ?? '').replace(/\/+$/, '')

function trimBase(v: string | undefined): string {
  return (v ?? '').trim().replace(/\/+$/, '')
}

/** config.json 的超时。它是同源的小文件，不该拖慢首屏。 */
const CONFIG_TIMEOUT = 3000

let pending: Promise<RuntimeConfig> | undefined

async function loadOnce(): Promise<RuntimeConfig> {
  const fallback: RuntimeConfig = {
    apiBase: BUILD_API_BASE,
    biliBase: BUILD_BILI_BASE || BUILD_API_BASE,
  }

  if (typeof fetch !== 'function') return fallback

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT)
  try {
    // no-store：改了 config.json 要立刻生效，不能被缓存挡住
    const res = await fetch('./config.json', { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return fallback

    const data = (await res.json()) as RuntimeConfig
    const apiBase = trimBase(data.apiBase) || fallback.apiBase
    return {
      apiBase,
      biliBase: trimBase(data.biliBase) || apiBase,
    }
  } catch {
    // 文件不存在、损坏、超时 —— 都静默退回构建期值。
    // 这是**有意的**：config.json 是可选增强，缺了不该让取数整体失败。
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

/** 读取运行时配置（同一页面生命周期内只解析一次） */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!pending) pending = loadOnce()
  return pending
}

/** 仅供测试使用：清掉记住的 Promise */
export function __resetRuntimeConfig(): void {
  pending = undefined
}
