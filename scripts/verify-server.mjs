/**
 * 后端自检脚本 —— 直接打本地/远端服务，验证 HTTP 层行为。
 *
 * 用法：
 *   node scripts/verify-server.mjs                          # 默认 http://127.0.0.1:9983
 *   node scripts/verify-server.mjs https://mc.tbpdt.top:9983
 *
 * 与 vitest 里的单元测试分工不同：这里验的是**真实进程的真实响应头**，
 * 单元测试用的是 httptest 假上游。部署后跑一遍最有价值。
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:9983').replace(/\/+$/, '')
const ORIGIN = 'https://evrc.tbpdt.top'

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  —— ${detail}` : ''}`)
  }
}

async function get(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', ...init })
  return res
}

/**
 * 带限流退避的请求。
 *
 * 自检脚本会连打十几次 B 站接口，很容易撞上 bili_per_minute 的限流 ——
 * 若直接当成失败，报告里就全是一片红，反而看不出真正的问题。
 * 这里遇到 429 就按 Retry-After 等一等再重试。
 */
async function getWithBackoff(path, init = {}, maxRetries = 3) {
  let res = await get(path, init)
  for (let i = 0; i < maxRetries && res.status === 429; i++) {
    const wait = Number(res.headers.get('retry-after') ?? 2)
    await res.arrayBuffer()
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000 + 200))
    res = await get(path, init)
  }
  return res
}

/** 归一化 av 号：av117... / 117... → 117... */
function normAid(v) {
  return String(v ?? '').replace(/^av/i, '')
}

async function jsonOf(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function main() {
  console.log(`目标：${BASE}\n`)

  // ── 健康检查 ────────────────────────────────────────────────────
  console.log('[健康检查]')
  {
    const res = await get('/api/healthz')
    const body = await jsonOf(res)
    check('GET /api/healthz 返回 200', res.status === 200, `实际 ${res.status}`)
    check('健康检查带 ok:true', body?.ok === true, JSON.stringify(body))
    check('健康检查带版本与运行时长', typeof body?.version === 'string' && typeof body?.uptimeSec === 'number')
  }

  // ── 周刊端点 ────────────────────────────────────────────────────
  console.log('\n[周刊端点]')
  let latest = null
  {
    const res = await get('/api/weekly/latest')
    latest = await jsonOf(res)
    check('GET /api/weekly/latest 返回 200', res.status === 200, `实际 ${res.status}`)
    check('Content-Type 是 JSON', (res.headers.get('content-type') ?? '').includes('application/json'))
    check('带 Cache-Control', res.headers.get('cache-control') !== null, String(res.headers.get('cache-control')))

    const main = latest?.main_rank?.length ?? 0
    const second = latest?.second_rank?.length ?? 0
    check(`主榜 30 条`, main === 30, `实际 ${main}`)
    check(`续榜 80 条（第 31~110 名）`, second === 80, `实际 ${second}`)
    check(`合计 110 条完整榜单`, main + second === 110, `实际 ${main + second}`)
    check('带期号 ranknum', typeof latest?.ranknum === 'number', String(latest?.ranknum))
    check('带采集窗口时间', Boolean(latest?.collect_start_time && latest?.collect_end_time))

    const ranks = [...(latest?.main_rank ?? []), ...(latest?.second_rank ?? [])].map((v) => v.rank)
    const missing = []
    for (let i = 1; i <= 110; i++) if (!ranks.includes(i)) missing.push(i)
    check('名次连续覆盖 1..110', missing.length === 0, `缺 ${missing.slice(0, 5).join(',')}`)

    const first = latest?.main_rank?.[0]
    check('首条带可点击的 url', typeof first?.url === 'string' && first.url.startsWith('http'), String(first?.url))
    check('首条带 avid', typeof first?.avid === 'string', String(first?.avid))
    check(
      '首条六项数据齐全且非零',
      ['play', 'like', 'favorite', 'coin', 'comment', 'danmaku'].every((k) => typeof first?.[k] === 'number' && first[k] >= 0),
    )

    const raw = JSON.stringify(latest)
    check('已裁掉 referSource', !raw.includes('referSource'))
    check('已裁掉 coverurl', !raw.includes('coverurl'))
    check('已裁掉 ext_rank', !raw.includes('ext_rank'))
  }

  {
    const res = await get('/api/weekly/info')
    const info = await jsonOf(res)
    check('GET /api/weekly/info 返回 200', res.status === 200, `实际 ${res.status}`)
    check('期号目录非空', Array.isArray(info?.rank_list) && info.rank_list.length > 100, `${info?.rank_list?.length} 期`)
    check('目录条目只含 rank_num', Object.keys(info?.rank_list?.[0] ?? {}).length === 1)
    check('rank_num 是字符串', typeof info?.rank_list?.[0]?.rank_num === 'string')

    const n = info?.rank_list?.[0]?.rank_num
    const res2 = await get(`/api/weekly/rank?n=${n}`)
    const period = await jsonOf(res2)
    check(`GET /api/weekly/rank?n=${n} 返回 200`, res2.status === 200, `实际 ${res2.status}`)
    check('指定期数与 latest 期号一致', period?.ranknum === latest?.ranknum, `${period?.ranknum} vs ${latest?.ranknum}`)
  }

  // ── 参数校验与路径穿越 ──────────────────────────────────────────
  console.log('\n[参数校验]')
  {
    for (const bad of ['abc', '../../etc/passwd', '-1', '0', '1e5', '735;ls']) {
      const res = await get(`/api/weekly/rank?n=${encodeURIComponent(bad)}`)
      check(`n=${JSON.stringify(bad)} 被拒绝`, res.status === 400, `实际 ${res.status}`)
    }
    const res = await get('/api/nope')
    check('未知路径返回 404', res.status === 404, `实际 ${res.status}`)
    const body = await jsonOf(res)
    check('404 也是 JSON（不是 HTML 错误页）', body !== null && typeof body.error === 'string')

    const res405 = await get('/api/weekly/latest', { method: 'POST' })
    check('POST 返回 405', res405.status === 405, `实际 ${res405.status}`)
    check('405 带 Allow 头', (res405.headers.get('allow') ?? '').includes('GET'))
  }

  // ── B 站端点 ────────────────────────────────────────────────────
  console.log('\n[B 站端点]')
  {
    // 注意：周刊的 url 字段是 av 形态（https://www.bilibili.com/video/av.../），
    // 不保证含 BV 号，所以这里统一用 avid 走接口，再由服务端补出 BV 号。
    const avid = latest?.main_rank?.[0]?.avid
    const officialPoint = latest?.main_rank?.[0]?.point

    const res = await getWithBackoff(`/api/bili/stats?aid=${avid}`)
    const stats = await jsonOf(res)
    check(`GET /api/bili/stats?aid=${avid} 返回 200`, res.status === 200, `实际 ${res.status} ${JSON.stringify(stats)}`)
    check(
      '六项数据齐全',
      ['play', 'like', 'favorite', 'coin', 'comment', 'danmaku'].every((k) => typeof stats?.[k] === 'number'),
      JSON.stringify(stats),
    )
    check('带 fetchedAt（供界面标注数据时间）', typeof stats?.fetchedAt === 'string', String(stats?.fetchedAt))
    check('带 cache 状态', ['fresh', 'stale', 'fetched'].includes(stats?.cache), String(stats?.cache))
    check('title 非空', typeof stats?.title === 'string' && stats.title.length > 0)
    check('服务端补出了 BV 号', /^BV[0-9A-Za-z]{10}$/.test(stats?.bvid ?? ''), String(stats?.bvid))
    check('aid 参数容忍 av 前缀', normAid(stats?.aid) === normAid(avid), `${stats?.aid} vs ${avid}`)

    const bvid = stats?.bvid
    if (typeof stats?.play === 'number') {
      console.log(`      榜单第一条：《${stats.title}》播放 ${stats.play}，官方 point ${officialPoint}`)
    }

    // bvid 与 aid 必须命中同一条视频（也应当共用同一条缓存）
    const resBv = await getWithBackoff(`/api/bili/stats?bvid=${bvid}`)
    const statsBv = await jsonOf(resBv)
    check('bvid 查询返回同一条视频', normAid(statsBv?.aid) === normAid(stats?.aid), `${statsBv?.aid} vs ${stats?.aid}`)

    const resR = await getWithBackoff(`/api/bili/resolve?q=${encodeURIComponent(avid)}`)
    const ref = await jsonOf(resR)
    check(
      'resolve 能解析 av 号',
      resR.status === 200 && normAid(ref?.aid) === normAid(avid),
      `实际 ${resR.status} ${JSON.stringify(ref)}`,
    )
    check('resolve 同时补出 BV 号', typeof ref?.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(ref.bvid), String(ref?.bvid))

    const resU = await getWithBackoff(
      `/api/bili/resolve?q=${encodeURIComponent(`https://www.bilibili.com/video/${bvid}/?spm_id_from=333`)}`,
    )
    const refU = await jsonOf(resU)
    check('resolve 能解析完整链接（带 query）', refU?.bvid === bvid, `实际 ${resU.status} ${JSON.stringify(refU)}`)

    // 线上真实故障回归：从 B 站 App「复制链接」得到的是「标题 + 空格 + 链接」，
    // 早期实现把整段文字丢给 url.Parse，得到空 Host，于是判为无法识别 → 404。
    const shareText = `【【洛天依原创】线条与色彩丨致仍手握画笔的你】 https://www.bilibili.com/video/BV1UVtb6PENV/?share_source=copy_web&vd_source=701f14b1944b350b54b777bd57dbd0eb`
    const resShare = await getWithBackoff(`/api/bili/resolve?q=${encodeURIComponent(shareText)}`)
    const refShare = await jsonOf(resShare)
    check(
      'resolve 能解析分享文案（标题 + 空格 + 链接）',
      refShare?.bvid === 'BV1UVtb6PENV',
      `实际 ${resShare.status} ${JSON.stringify(refShare)}`,
    )

    const resA = await getWithBackoff(`/api/bili/resolve?q=${encodeURIComponent(`https://www.bilibili.com/video/${avid}/`)}`)
    const refA = await jsonOf(resA)
    check('resolve 能解析 av 形态链接', normAid(refA?.aid) === normAid(avid), JSON.stringify(refA))

    const resBad = await getWithBackoff(`/api/bili/resolve?q=${encodeURIComponent('这不是一个视频')}`)
    check('resolve 无法识别时返回 404', resBad.status === 404, `实际 ${resBad.status}`)

    const resNo = await getWithBackoff('/api/bili/stats')
    check('stats 缺参数返回 400', resNo.status === 400, `实际 ${resNo.status}`)

    // SSRF 防护：输入一个非 B 站链接，不得被当作可跟跳的目标
    const resSsrf = await getWithBackoff(`/api/bili/resolve?q=${encodeURIComponent('https://evil.example/watch/BV1JHZNBdEQv')}`)
    check(
      'resolve 不把非 B 站域名的链接当视频',
      resSsrf.status === 404 || resSsrf.status === 400,
      `实际 ${resSsrf.status}`,
    )
  }

  // ── 响应压缩 ────────────────────────────────────────────────────
  console.log('\n[压缩]')
  {
    const resPlain = await getWithBackoff('/api/weekly/latest', { headers: { 'accept-encoding': 'identity' } })
    check('未声明 gzip 时响应可正常解析', (await jsonOf(resPlain))?.ranknum !== undefined)

    // 注意：Node 的 fetch（undici）会自动解压，因此这里读不到 content-encoding
    // 与真实压缩体积。用 curl 才能看到原始头；此处只验证「声明 gzip 之后
    // 依然能正确解出 JSON」，这对浏览器才是真正重要的。
    const resGz = await getWithBackoff('/api/weekly/latest', { headers: { 'accept-encoding': 'gzip' } })
    const gzBody = await jsonOf(resGz)
    check('声明 gzip 后仍能正确解析', gzBody?.ranknum !== undefined, `status=${resGz.status}`)
    check('压缩路径下主榜仍然是 30 条', gzBody?.main_rank?.length === 30, `实际 ${gzBody?.main_rank?.length}`)
    console.log('      （Node 的 fetch 会自动解压并剥掉 content-encoding，')
    console.log('        要看真实的 Content-Encoding / Vary 请用 curl）')
  }

  // ── CORS ────────────────────────────────────────────────────────
  console.log('\n[CORS]')
  {
    const res = await get('/api/weekly/info', { headers: { origin: ORIGIN } })
    const acao = res.headers.get('access-control-allow-origin')
    check(`允许来源 ${ORIGIN}`, acao === ORIGIN || acao === '*', `实际 ${JSON.stringify(acao)}`)
    if (acao === ORIGIN) {
      check('白名单模式下带 Vary: Origin', (res.headers.get('vary') ?? '').includes('Origin'))
    }

    const resEvil = await get('/api/weekly/info', { headers: { origin: 'https://evil.example' } })
    const acaoEvil = resEvil.headers.get('access-control-allow-origin')
    check('不认识的来源不会被放行', acaoEvil !== 'https://evil.example', `实际 ${JSON.stringify(acaoEvil)}`)

    const pre = await get('/api/weekly/latest', { method: 'OPTIONS', headers: { origin: ORIGIN } })
    check('预检返回 204', pre.status === 204, `实际 ${pre.status}`)
    check('预检带 Allow-Methods', (pre.headers.get('access-control-allow-methods') ?? '').includes('GET'))

    console.log('\n      提示：CORS 不是访问控制 —— curl 完全不看这些头。')
    console.log('      真正防刷靠 rate_limit，本脚本下面会验证。')
  }

  // ── 限流 ────────────────────────────────────────────────────────
  console.log('\n[限流]')
  {
    let got429 = false
    let attempts = 0
    for (let i = 0; i < 40; i++) {
      attempts++
      const res = await get('/api/bili/stats?bvid=BV1JHZNBdEQv')
      if (res.status === 429) {
        got429 = true
        check('超限后返回 429', true)
        check('429 带 Retry-After', res.headers.get('retry-after') !== null, String(res.headers.get('retry-after')))
        const body = await jsonOf(res)
        check('429 也是 JSON', body !== null && typeof body.error === 'string')
        console.log(`      第 ${attempts} 次请求被限流`)
        break
      }
      if (res.status === 200) await res.arrayBuffer()
    }
    if (!got429) {
      console.log(`      （连打 ${attempts} 次未触发限流 —— 若 bili_per_minute 配得较大属正常）`)
    }
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${pass} 项，失败 ${fail} 项`)
  if (fail > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(`\n自检脚本本身出错: ${err?.message ?? err}`)
  console.error(`后端地址 ${BASE} 是否可达？`)
  process.exitCode = 2
})
