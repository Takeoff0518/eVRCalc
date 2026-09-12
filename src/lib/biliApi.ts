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

/**
 * B 站接口基地址。
 *
 * 默认与周刊同一个后端 —— Go 后端把两边都接管了，所以两个变量通常填一样。
 * 分成两个变量只是为了将来把 B 站那半边单独挪走时不至于改代码。
 */
const BILI_BASE = (
  import.meta.env.VITE_BILI_BASE ??
  import.meta.env.VITE_API_BASE ??
  ''
).replace(/\/+$/, '')

function biliUrl(path: string): string {
  return `${BILI_BASE}${path}`
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
export function fetchBiliStats(
  ref: { bvid?: string; aid?: string },
): Promise<FetchResult<BiliStats>> {
  const bvid = ref.bvid?.trim()
  const aid = ref.aid?.trim()

  const q = bvid
    ? `bvid=${encodeURIComponent(bvid)}`
    : aid
      ? `aid=${encodeURIComponent(aid)}`
      : ''
  if (!q) return Promise.resolve({ ok: false, error: '缺少 BV 号或 av 号' })

  return fetchJson<BiliStats>(biliUrl(`/api/bili/stats?${q}`), BILI_TIMEOUT)
}

/**
 * 把任意输入解析成规范化标识。
 *
 * 支持 BV 号 / av 号 / 纯数字 / 完整链接 / b23.tv 短链（短链由后端跟跳）。
 */
export function resolveBiliInput(input: string): Promise<FetchResult<BiliRef>> {
  const q = (input ?? '').trim()
  if (!q) return Promise.resolve({ ok: false, error: '请输入视频链接或 BV / av 号' })
  return fetchJson<BiliRef>(biliUrl(`/api/bili/resolve?q=${encodeURIComponent(q)}`), BILI_TIMEOUT)
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

/** 把 RFC3339 时间格式化成「14:23」这样的短标签 */
export function formatFetchedAt(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
