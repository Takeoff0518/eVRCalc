/**
 * eVRCalc 同源代理 —— Cloudflare Worker
 *
 * 存在的唯一原因：浏览器无法直连这两个 API（见 plan.md §1.3）
 *   · evocalrank.com 从不返回 Access-Control-Allow-Origin
 *   · api.bilibili.com 对非 bilibili 域 Origin 直接 403（CORS 之前就拒）
 *
 * 前端部署在 GitHub Pages（evrc.tbpdt.top），本 Worker 部署在 Cloudflare
 * 的另一个子域，两者**跨域**，因此这里必须主动补上 CORS 响应头。
 *
 * 实测确认（见 plan.md §1.3）：
 *   · evocalrank 完全不看 Origin 头，带外来 Origin 仍返回 200
 *   · api.bilibili.com 必须**不带 Origin** 才放行 —— 所以转发时绝不能透传 Origin
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const WEEKLY_ORIGIN = 'https://www.evocalrank.com'
const BILI_ORIGIN = 'https://www.bilibili.com'
const BILI_API = 'https://api.bilibili.com'

/**
 * CORS 允许来源。
 * 默认 `*`：本 Worker 不携带任何凭据（无 Cookie、无 Authorization），
 * 全部接口都是公开只读数据，无需限制来源。
 * 若想收紧，在面板里加环境变量 ALLOWED_ORIGIN = https://evrc.tbpdt.top
 */
const DEFAULT_ALLOWED_ORIGIN = '*'

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

async function upstream(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      // 刻意不设置 Origin —— 这是 B 站 WAF 放行的关键
    },
  })
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`)
  return res.json()
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

    try {
      // ── 周刊 ────────────────────────────────────────────────
      if (pathname === '/api/weekly/info') {
        return json(
          await upstream(`${WEEKLY_ORIGIN}/data/info/info.json`, `${WEEKLY_ORIGIN}/`),
          200,
          3600,
          env,
        )
      }

      if (pathname === '/api/weekly/latest') {
        return json(
          await upstream(`${WEEKLY_ORIGIN}/data/info/latest.json`, `${WEEKLY_ORIGIN}/`),
          200,
          600,
          env,
        )
      }

      if (pathname === '/api/weekly/rank') {
        const n = digitsOnly(searchParams.get('n'))
        if (!n) return json({ error: 'missing n' }, 400, 0, env)
        return json(
          await upstream(`${WEEKLY_ORIGIN}/data/rank_data/${n}.json`, `${WEEKLY_ORIGIN}/`),
          200,
          86400,
          env,
        )
      }

      // ── B 站 ────────────────────────────────────────────────
      if (pathname === '/api/bili/view') {
        const bvid = searchParams.get('bvid')
        const aid = digitsOnly(searchParams.get('aid'))
        if (!bvid && !aid) return json({ error: 'missing bvid/aid' }, 400, 0, env)

        const query = bvid
          ? `bvid=${encodeURIComponent(bvid)}`
          : `aid=${encodeURIComponent(aid)}`

        return json(
          await upstream(`${BILI_API}/x/web-interface/view?${query}`, `${BILI_ORIGIN}/`),
          200,
          120,
          env,
        )
      }

      return json({ error: 'not found' }, 404, 0, env)
    } catch (err) {
      // 用 502 而不是让异常冒泡成 Cloudflare 的 HTML 错误页，
      // 这样浏览器能拿到可读的 JSON，也便于前端展示失败原因
      return json({ error: String((err && err.message) || err) }, 502, 0, env)
    }
  },
}
