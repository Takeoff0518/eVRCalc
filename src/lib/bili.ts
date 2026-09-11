/**
 * B 站视频标识解析：URL / BV 号 / av 号 → 规范化标识
 *
 * 支持输入形态：
 *   BV1WeZLBtEW1
 *   av116067884077341 / AV116067884077341
 *   https://www.bilibili.com/video/BV1WeZLBtEW1
 *   https://www.bilibili.com/video/BV1WeZLBtEW1/?spm_id_from=...
 *   https://www.bilibili.com/video/av116067884077341/
 *   https://b23.tv/xxxxx          （短链，需网络解析，本模块不处理）
 *   https://m.bilibili.com/video/BV...
 */

export interface BiliRef {
  /** 原始输入 */
  raw: string
  /** BV 号（若可确定） */
  bvid?: string
  /** av 号（纯数字，若可确定） */
  aid?: string
  /** 来源形态 */
  kind: 'bvid' | 'avid' | 'url-bvid' | 'url-avid' | 'shortlink' | 'invalid'
}

const BV_RE = /BV[0-9A-Za-z]{10}/
const AV_RE = /av(\d+)/i
const AID_QUERY_RE = /[?&]aid=(\d+)/i
const BVID_QUERY_RE = /[?&]bvid=(BV[0-9A-Za-z]{10})/i

/** 解析用户输入的视频标识 */
export function parseBiliRef(input: string): BiliRef {
  const raw = (input ?? '').trim()
  if (!raw) return { raw, kind: 'invalid' }

  // 纯 BV 号
  const bvOnly = raw.match(/^(BV[0-9A-Za-z]{10})$/)
  if (bvOnly) return { raw, bvid: bvOnly[1], kind: 'bvid' }

  // 纯 av 号
  const avOnly = raw.match(/^av(\d+)$/i)
  if (avOnly) return { raw, aid: avOnly[1], kind: 'avid' }

  // 纯数字（视作 aid）
  const numOnly = raw.match(/^(\d{4,})$/)
  if (numOnly) return { raw, aid: numOnly[1], kind: 'avid' }

  // b23.tv 短链
  if (/^https?:\/\/b23\.tv\//i.test(raw) || /^b23\.tv\//i.test(raw)) {
    return { raw, kind: 'shortlink' }
  }

  // 任意 URL：优先看路径，再看 query
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    const pathAndQuery = url.pathname + url.search

    // 注意：BV_RE 无捕获组、BVID_QUERY_RE 有捕获组，因此用 `m[1] ?? m[0]` 统一取值
    const bv = pathAndQuery.match(BV_RE) ?? pathAndQuery.match(BVID_QUERY_RE)
    if (bv) return { raw, bvid: bv[1] ?? bv[0], kind: 'url-bvid' }

    const av = pathAndQuery.match(AV_RE)
    if (av) return { raw, aid: av[1] ?? av[0].replace(/^av/i, ''), kind: 'url-avid' }

    const aidQuery = url.search.match(AID_QUERY_RE)
    if (aidQuery) return { raw, aid: aidQuery[1] ?? aidQuery[0], kind: 'url-avid' }
  } catch {
    // 落到下面的兜底匹配
  }

  // 兜底：输入里任意位置出现 BV 号
  const looseBv = raw.match(BV_RE)
  if (looseBv) return { raw, bvid: looseBv[0], kind: 'bvid' }

  const looseAv = raw.match(AV_RE)
  if (looseAv) return { raw, aid: looseAv[1], kind: 'avid' }

  return { raw, kind: 'invalid' }
}

/** 从任意字符串中提取 avid（周刊数据里是 `av116067884077341` 这种形态） */
export function avidToAid(avid: string): string | undefined {
  const m = (avid ?? '').match(/^av(\d+)$/i)
  return m ? m[1] : undefined
}

/** 规范化 avid，便于比较：`av123` → `123` */
export function normalizeAvid(avid: string | undefined): string {
  if (!avid) return ''
  const m = avid.match(/^av(\d+)$/i)
  return m ? m[1] : avid.trim()
}

/**
 * av 号 → BV 号
 *
 * 移植自 draft.md 提供的 Kotlin 实现。注意 Kotlin 版本在 `bytes` 上做两次交换
 * （swap(3,9)、swap(4,7)）后直接返回；本实现按同样顺序在字符数组上交换，
 * 结果与 Bilibili 官方算法一致：av2 → BV1xx411c7mD。
 *
 * 本项目其实不需要这个转换（view 接口直接支持 aid= 参数），
 * 保留它是为了界面可以回显 BV 号，以及将来可能的兼容需求。
 */
export function avToBv(avId: string): string {
  const XOR_CODE = 23442827791579n
  const MAX_AID = 1n << 51n
  const DATA = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'
  const BASE = 58n

  const digits = (avId ?? '').replace(/^av/i, '').replace(/\D/g, '')
  if (!digits) return ''
  let aid: bigint
  try {
    aid = BigInt(digits)
  } catch {
    return ''
  }

  const bytes = 'BV1000000000'.split('')
  let tmp = (MAX_AID | aid) ^ XOR_CODE

  let bvIdx = bytes.length - 1
  while (tmp > 0n) {
    bytes[bvIdx] = DATA[Number(tmp % BASE)]
    tmp /= BASE
    bvIdx--
  }

  const swap = (i: number, j: number) => {
    const t = bytes[i]
    bytes[i] = bytes[j]
    bytes[j] = t
  }
  swap(3, 9)
  swap(4, 7)

  return bytes.join('')
}
