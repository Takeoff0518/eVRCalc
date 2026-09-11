/**
 * 周刊数据缓存
 *
 * 用 Cache Storage（而非 localStorage）：
 * - 周刊 JSON 有 60~70 KB，Cache Storage 存 Response 更自然，无 5MB 字符串配额压力
 * - 以**期号**为键，因此换期自动失效，无需手动清理
 *
 * 降级目标（plan.md §4）：Worker 离线时优先回退到缓存，让周刊功能在断网状态下也能用。
 */

const CACHE_NAME = 'evrcalc-weekly-v1'

function hasCacheStorage(): boolean {
  return typeof caches !== 'undefined'
}

/** 读取某期缓存，返回 Response（未命中则 undefined） */
async function matchPeriod(n: number): Promise<Response | undefined> {
  if (!hasCacheStorage()) return undefined
  try {
    return await caches.match(`/__evrcalc__/weekly/${n}`)
  } catch {
    return undefined
  }
}

/** 写入某期缓存 */
async function putPeriod(n: number, payload: unknown): Promise<void> {
  if (!hasCacheStorage()) return
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(
      `/__evrcalc__/weekly/${n}`,
      new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'x-evocalc-cached-at': String(Date.now()),
        },
      }),
    )
  } catch {
    // 缓存失败不影响功能
  }
}

export interface CachedPeriod<T> {
  data: T
  /** 缓存写入时间戳；来自网络时为 0 */
  cachedAt: number
  fromCache: boolean
}

/**
 * 带缓存的期刊读取：先网络，失败回退缓存。
 * 返回 undefined 表示既没网络也没缓存 —— 调用方据此隐藏周刊相关区块。
 *
 * `fetchInfo` 由调用方注入（而不是在这里硬拼 URL），
 * 以免 API 基地址（VITE_API_BASE）的知识散落到两个模块里。
 */
export async function loadPeriodWithCache<T extends { ranknum: number }>(
  fetchFn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
  fetchInfo: () => Promise<{ ok: true; data: { rank_list?: { rank_num: string }[] } } | { ok: false; error: string }>,
): Promise<{ result?: CachedPeriod<T>; error?: string }> {
  const fresh = await fetchFn()
  if (fresh.ok) {
    void putPeriod(fresh.data.ranknum, fresh.data)
    return { result: { data: fresh.data, cachedAt: 0, fromCache: false } }
  }

  // 网络失败 —— 但我们还不知道期号，需要先问目录（同样允许失败）
  const info = await fetchInfo()
  const latestNum = info.ok ? info.data.rank_list?.[0]?.rank_num : undefined
  if (latestNum) {
    const hit = await matchPeriod(Number(latestNum))
    if (hit) {
      try {
        const data = (await hit.json()) as T
        return {
          result: { data, cachedAt: Number(hit.headers.get('x-evocalc-cached-at') ?? 0), fromCache: true },
        }
      } catch {
        // 缓存损坏，忽略
      }
    }
  }

  return { error: fresh.error }
}
