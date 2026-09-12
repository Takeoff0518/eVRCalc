/**
 * eVRCalc 同源代理 —— Cloudflare Worker
 *
 * ⚠️ 已停用（2026-09）。周刊查询已迁移到 `server/`（Go 后端），
 *    前端不再指向 https://api.tbpdt.top。
 *
 * 之所以保留这份代码：它是一份实测有效的参考实现，也是万一 Go 后端那台机器
 * 长期不可用时的回退路径 —— 把前端构建时的 VITE_API_BASE 指回这里、
 * 重新 `npx wrangler deploy` 即可恢复周刊功能（B 站那半边搬不回来，
 * 因为 WAF 拒绝机房 IP）。
 *
 * ── 原始说明 ──────────────────────────────────────────────────────
 * 存在的唯一原因：浏览器无法直连周刊接口。
 *   www.evocalrank.com 的 JSON 接口从不返回 Access-Control-Allow-Origin，
 *   浏览器会直接丢弃整个响应（即使服务端返回 200 与完整数据）。
 *   实测：带 Origin 请求返回 200 但无 ACAO，且服务端并不校验 Origin。
 *
 * ── 关于「只允许某个域名请求」（重要认知）──────────────────────────
 * CORS 响应头**不是访问控制**，它只是浏览器自愿遵守的规则：
 * 爬虫用 curl / python requests 时完全不看 ACAO，照样拿到数据。
 * 因此把 ACAO 收紧成白名单**挡不住刷量**，只能阻止"别人的网页在浏览器里
 * 读我们的响应"。真正有效的手段是下面两条：
 *   1. 边缘缓存（大幅降低请求穿透到上游的次数）
 *   2. 限流（对异常高频的来源返回 429）
 *
 * ── 关于 B 站接口（已移除，结论保留备查）────────────────────────
 * 曾经在此转发 api.bilibili.com 的视频数据接口，实测确认不可行：
 *   · 该接口的 WAF 按 Origin 白名单拒绝非 bilibili 域名（403）
 *   · 去掉 Origin 后本机能通，但 Cloudflare Workers 出口得到 412
 *   · 逐个排除请求头差异（UA / Accept-Language / Sec-Fetch-* / 裸请求）
 *     后确认：本机住宅 IP 请求全部 200，Worker 请求 412 —— 差别只在出口 IP
 *   即「WAF 拒绝数据中心 IP」，不是请求特征问题，换任何 Serverless 都一样。
 * 结论：B 站数据只能从住宅 IP 取，因此由 server/ 里的 Go 后端承担。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const WEEKLY_ORIGIN = 'https://www.evocalrank.com'

/**
 * CORS 允许来源。默认 `*`。
 *
 * 想收紧可加环境变量 ALLOWED_ORIGIN = https://evrc.tbpdt.top，
 * 但请明白如上所述：这只影响浏览器，不影响爬虫。
 */
const DEFAULT_ALLOWED_ORIGIN = '*'

/** 上游各接口的缓存秒数，配置在 ROUTES 里 */
const ROUTES = {
  '/api/weekly/latest': {
    upstream: `${WEEKLY_ORIGIN}/data/info/latest.json`,
    ttl: 600,
    trim: 'period',
  },
  '/api/weekly/info': {
    upstream: `${WEEKLY_ORIGIN}/data/info/info.json`,
    ttl: 3600,
    trim: 'info',
  },
  '/api/weekly/rank': {
    upstream: (sp) => {
      const n = digitsOnly(sp.get('n'))
      return n ? `${WEEKLY_ORIGIN}/data/rank_data/${n}.json` : null
    },
    ttl: 86400,
    trim: 'period',
  },
}

/** 只用数字，杜绝路径穿越 */
const digitsOnly = (s) => (s ?? '').replace(/\D/g, '')

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env?.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    // 同一份数据对不同来源响应一致，避免代理/CDN 缓存串味
    vary: 'Origin',
  }
}

function json(data, status = 200, maxAge = 300, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
      ...corsHeaders(env),
    },
  })
}

/**
 * 取上游数据，并尝试让 Cloudflare 边缘也缓存这次子请求。
 *
 * 默认情况下 Workers 的 fetch 子请求不缓存，`cache-control` 只作用于浏览器，
 * 结果是每个访客的每次请求都穿透到 evocalrank。加 `cacheEverything` + `cacheTtl`
 * 意在让同一 Cloudflare 节点在 TTL 内只回上游一次。
 *
 * 实测补充（2026-09，本机无法完全确认）：
 *   · 上游该接口**不发送 cache-control**，因此不存在"上游头覆盖我们的 TTL"的问题
 *   · 但客户端也读不到 cf-cache-status / age，无法直接证明命中
 *   · 观测到的延迟由首访 ~1300ms 稳定到 ~750ms，有改善但不足以断定是边缘缓存
 * 也就是说这条缓存**可能生效、也可能没有**；真正能确认防刷效果的是限流绑定，
 * 那个已实测有效（第 29 次请求开始返回 429）。
 */
async function upstream(url, ttl) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${WEEKLY_ORIGIN}/`,
      Accept: 'application/json, text/plain, */*',
    },
    cf: {
      cacheEverything: true,
      cacheTtl: ttl,
    },
  })
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`)
  return res.json()
}

// ── 响应裁剪 ────────────────────────────────────────────────────
// 上游一份 latest.json 有 63.8 KB，其中一大半是用不到的字段：
//   · referSource  约 116 字节/条 —— 与外部六个字段重复的同快照，纯冗余（最大浪费）
//   · coverurl      约 60 字节/条 —— 界面不显示封面
//   · pubdate       约 21 字节/条
//   · share          约 4 字节/条
//   · 整段 oth_pickup / thanks_list / statistic 等 —— 一律不用
// 只保留下述字段后降到约 24 KB（省 63%）。
//
// 权衡：这让 Worker 与前端的数据形状耦合 —— 前端若要多要一个字段，
// 需要同步改这里并重新部署。当前项目规模下这个代价可接受。
const VIDEO_FIELDS = [
  'url', // 供排名区标题点击跳转
  'avid',
  'title',
  'point',
  'rank',
  'play',
  'like',
  'favorite',
  'coin',
  'comment',
  'danmaku',
]

function trimVideo(v) {
  const out = {}
  for (const f of VIDEO_FIELDS) {
    if (v?.[f] !== undefined) out[f] = v[f]
  }
  return out
}

function trimVideoList(list) {
  return Array.isArray(list) ? list.map(trimVideo) : []
}

/**
 * 裁剪一份期刊数据。
 * main_rank 是第 1~30 名，second_rank 是第 31~110 名，**两段合起来才是完整榜单**，
 * 因此两个数组都必须保留。
 */
function trimPeriod(p) {
  return {
    ranknum: p.ranknum,
    generate_time: p.generate_time,
    collect_start_time: p.collect_start_time,
    collect_end_time: p.collect_end_time,
    main_rank: trimVideoList(p.main_rank),
    second_rank: trimVideoList(p.second_rank),
  }
}

/**
 * 裁剪期数目录。
 * 上游 info.json 有 36 KB，但前端只用它取"最新期号"来定位缓存，
 * 其余（每期的封面地址等）一律不需要。这里只返回期号列表。
 */
function trimInfo(info) {
  const list = Array.isArray(info?.rank_list) ? info.rank_list : []
  return {
    generate_time: info?.generate_time,
    rank_list: list.map((e) => ({ rank_num: String(e.rank_num) })),
  }
}

const TRIMS = { period: trimPeriod, info: trimInfo }

/**
 * 限流键。
 *
 * 官方文档建议不要只按 IP 限流（移动网络下大量用户共用一个出口 IP），
 * 并指出限流计数是**按 Cloudflare 节点**独立的。因此这里把
 * 「国家 + 节点 + IP」组合成键：既避免跨节点互相影响，
 * 也避免把共享 IP 的不同用户误判成同一个人到离谱的程度。
 */
function rateLimitKey(request) {
  const cf = request.cf ?? {}
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  return `${cf.country ?? 'XX'}:${cf.colo ?? 'XX'}:${ip}`
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url)

    // 预检（当前接口都是简单 GET，不会触发，但保留以防将来加自定义头）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) })
    }

    if (!pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404, 0, env)
    }

    // ── 限流 ────────────────────────────────────────────────────
    // 窗口与阈值配置在 wrangler.jsonc 的 ratelimits 绑定里。
    // 绑定缺失时（例如本地 wrangler dev 未配置）跳过限流，不影响功能。
    if (env?.RATE_LIMITER) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey(request) })
        if (!success) {
          return json({ error: '请求过于频繁，请稍后再试' }, 429, 0, env)
        }
      } catch {
        // 限流服务异常时放行，避免因限流本身导致接口不可用
      }
    }

    const route = ROUTES[pathname]
    if (!route) {
      return json({ error: 'not found' }, 404, 0, env)
    }

    try {
      const url = typeof route.upstream === 'function' ? route.upstream(searchParams) : route.upstream
      if (!url) return json({ error: 'missing n' }, 400, 0, env)

      const raw = await upstream(url, route.ttl)
      return json(TRIMS[route.trim](raw), 200, route.ttl, env)
    } catch (err) {
      // 用 502 而不是让异常冒泡成 Cloudflare 的 HTML 错误页，
      // 这样浏览器能拿到可读的 JSON，也便于前端展示失败原因
      return json({ error: String((err && err.message) || err) }, 502, 0, env)
    }
  },
}
