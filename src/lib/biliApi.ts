/**
 * B 站数据取数层
 *
 * 与 `api.ts` 分开的原因：两者指向**不同的后端**。
 * 周刊接口在后端上，B 站接口也在同一个后端上 —— 但它们的失败语义不同，
 * 且 B 站那条路只有在家里的服务在线时才可用，需要单独降级。
 *
 * 铁律（沿用 api.ts）：**永不 throw，永不阻塞首屏**。
 */

import { fetchJson, type FetchResult } from './api'
import { loadRuntimeConfig } from './runtimeConfig'

async function biliUrl(path: string): Promise<string> {
  // biliBase 缺省时由 runtimeConfig 回落到 apiBase —— 周刊与 B 站目前由
  // 同一个 Go 后端提供，拆开只是为了将来能把 B 站那半边单独挪走。
  const { biliBase, apiBase } = await loadRuntimeConfig()
  return `${biliBase || apiBase}${path}`
}

/** `/api/bili/stats` 的响应 */
export interface BiliStats {
  bvid: string
  aid: number
  title: string
  /** 服务端取数时间（RFC3339） */
  fetchedAt: string
  /** fresh / stale / fetched —— stale 表示上游挂了、这是回吐的旧数据 */
  cache: 'fresh' | 'stale' | 'fetched'
  play: number
  like: number
  favorite: number
  coin: number
  comment: number
  danmaku: number
}

/** `/api/bili/resolve` 的响应 */
export interface BiliRef {
  raw: string
  bvid?: string
  aid?: string
  kind: 'bvid' | 'avid' | 'url-bvid' | 'url-avid' | 'shortlink' | 'invalid'
  title?: string
}

/** B 站接口超时给得比周刊宽 —— 它要打上游 B 站，链路更长 */
const BILI_TIMEOUT = 12000

/**
 * 查询单条视频的六项数据。
 *
 * `bvid` 与 `aid` 传其一即可。周刊榜单里的 `avid` 字段形如 `av117207459697071`，
 * 可以直接透传 —— 后端会容忍 `av` 前缀并补出 BV 号。
 */
export async function fetchBiliStats(
  ref: { bvid?: string; aid?: string },
): Promise<FetchResult<BiliStats>> {
  const bvid = ref.bvid?.trim()
  const aid = ref.aid?.trim()

  const q = bvid
    ? `bvid=${encodeURIComponent(bvid)}`
    : aid
      ? `aid=${encodeURIComponent(aid)}`
      : ''
  if (!q) return { ok: false, error: '缺少 BV 号或 av 号' }

  return fetchJson<BiliStats>(await biliUrl(`/api/bili/stats?${q}`), BILI_TIMEOUT)
}

/**
 * 把任意输入解析成规范化标识。
 *
 * 支持 BV 号 / av 号 / 纯数字 / 完整链接 / b23.tv 短链（短链由后端跟跳）。
 */
export async function resolveBiliInput(input: string): Promise<FetchResult<BiliRef>> {
  const q = (input ?? '').trim()
  if (!q) return { ok: false, error: '请输入视频链接或 BV / av 号' }
  return fetchJson<BiliRef>(await biliUrl(`/api/bili/resolve?q=${encodeURIComponent(q)}`), BILI_TIMEOUT)
}

/** 从周刊榜单条目里取出可用的查询标识 */
export function refFromVideo(video: { avid?: string; url?: string }): { bvid?: string; aid?: string } {
  const avid = (video.avid ?? '').trim()
  if (avid) return { aid: avid }

  // 兜底：从 url 里找 BV 号
  const m = (video.url ?? '').match(/BV[0-9A-Za-z]{10}/)
  if (m) return { bvid: m[0] }

  const av = (video.url ?? '').match(/av(\d+)/i)
  if (av) return { aid: av[1] }

  return {}
}

/** 把 RFC3339 时间格式化成「14:23」或「09-07 14:23」这样的短标签 */
export function formatFetchedAt(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 把底层错误翻成**可操作**的说明。
 *
 * 起因：直连部署时最常踩的坑是「前端在 https、后端只有 http」，浏览器的
 * 报错是一句没有信息量的 `Failed to fetch`，用户完全看不出问题在哪。
 * 这里明确指出来，省掉一轮来回排查。
 */
export async function explainFetchError(raw: string): Promise<string> {
  const msg = (raw ?? '').trim()

  let scheme = ''
  try {
    const { apiBase, biliBase } = await loadRuntimeConfig()
    scheme = (biliBase || apiBase || '').split('://')[0].toLowerCase()
  } catch {
    // 配置读不出来也不影响下面的判断
  }

  const pageIsHttps =
    typeof location !== 'undefined' && location.protocol === 'https:'

  // 有信息量的错误照原样带出去，只在末尾补一句定位提示
  if (/HTTP 5\d\d/.test(msg)) {
    return `${msg}（后端在运行，但它连不上上游；用 --check 看一下）`
  }
  if (msg.includes('请求超时')) {
    return `请求超时${scheme ? `（${scheme} 连不通）` : ''}。检查后端是否在运行、端口是否放行。`
  }

  const looksLikeNetwork = /failed to fetch|networkerror|load failed|网络请求失败|fetch failed/i.test(msg)
  if (!looksLikeNetwork) return msg

  if (pageIsHttps && scheme === 'http') {
    return '页面是 HTTPS，而 API 地址是 HTTP —— 浏览器会拦截这种混合内容请求。后端需要启用 HTTPS（见 DEPLOY.md）。'
  }
  if (pageIsHttps && scheme === 'https') {
    return '连不上后端。常见原因：证书无效或自签（浏览器会拒绝）、端口未放行、或后端没在运行。'
  }
  if (!scheme) {
    return '连不上后端，且没读到 API 地址配置（config.json / VITE_API_BASE 都没生效）。'
  }
  return `连不上后端（${scheme}）。检查服务是否在运行、地址是否正确。`
}

/** 从任意异常里取出可读信息 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}
