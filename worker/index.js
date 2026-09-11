/**
 * eVRCalc API 转发层 —— Cloudflare Worker
 *
 * 存在的唯一原因：浏览器无法直连周刊接口。
 *   www.evocalrank.com 的 JSON 接口从不返回 Access-Control-Allow-Origin，
 *   浏览器会直接丢弃整个响应（即使服务端返回 200 与完整数据）。
 *   实测：带 Origin 请求返回 200 但无 ACAO，且服务端并不校验 Origin。
 *
 * 前端部署于 GitHub Pages（evrc.tbpdt.top），本 Worker 在另一个子域，
 * 两者跨域，因此这里必须主动补上 CORS 响应头。
 *
 * ── 关于 B 站接口（已移除，结论保留备查）────────────────────────
 * 曾经在此转发 api.bilibili.com 的视频数据接口，实测确认不可行：
 *   · 该接口的 WAF 按 Origin 白名单拒绝非 bilibili 域名（403）
 *   · 去掉 Origin 后本机能通，但 Cloudflare Workers 出口得到 **412**
 *   · 逐个排除请求头差异（UA / Accept-Language / Sec-Fetch-* / 裸请求）
 *     后确认：本机住宅 IP 请求全部 200，Worker 请求 412 —— 差别只在出口 IP
 *   即「WAF 拒绝数据中心 IP」，不是请求特征问题，换任何 Serverless 都一样。
 * 因此 B 站数据改由 bookmarklet 在 bilibili.com 页面上同源抓取
 * （见 tools/bookmarklet.src.js）。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const WEEKLY_ORIGIN = 'https://www.evocalrank.com'

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
// 只保留下述字段后降到约 27 KB（省 57%）。
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
      if (pathname === '/api/weekly/info') {
        const raw = await upstream(`${WEEKLY_ORIGIN}/data/info/info.json`, `${WEEKLY_ORIGIN}/`)
        return json(trimInfo(raw), 200, 3600, env)
      }

      if (pathname === '/api/weekly/latest') {
        const raw = await upstream(`${WEEKLY_ORIGIN}/data/info/latest.json`, `${WEEKLY_ORIGIN}/`)
        return json(trimPeriod(raw), 200, 600, env)
      }

      if (pathname === '/api/weekly/rank') {
        const n = digitsOnly(searchParams.get('n'))
        if (!n) return json({ error: 'missing n' }, 400, 0, env)
        const raw = await upstream(`${WEEKLY_ORIGIN}/data/rank_data/${n}.json`, `${WEEKLY_ORIGIN}/`)
        return json(trimPeriod(raw), 200, 86400, env)
      }

      return json({ error: 'not found' }, 404, 0, env)
    } catch (err) {
      // 用 502 而不是让异常冒泡成 Cloudflare 的 HTML 错误页，
      // 这样浏览器能拿到可读的 JSON，也便于前端展示失败原因
      return json({ error: String((err && err.message) || err) }, 502, 0, env)
    }
  },
}
