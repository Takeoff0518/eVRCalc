/**
 * 精确模拟 Cloudflare 的回源，分别用 http 与 https 打源站。
 *
 * 为什么需要它：橙云报 522 时，你无法从浏览器分辨「端口不对」还是「协议不对」。
 * Cloudflare 不会告诉你细节。而这个脚本在**本机之外**跑，直接用两种协议去连
 * 你那个回源端口，一眼就能看出哪种通 —— 于是 522 的原因立刻确定。
 *
 * 用法：
 *   node scripts/check-origin-pull.mjs mc.tbpdt.top 9983
 *   node scripts/check-origin-pull.mjs mc.tbpdt.top 9983 api2.tbpdt.top
 *
 * 第三个参数可选：带上它就会额外测试「通过橙云域名走标准 443」的完整链路。
 */

import net from 'node:net'
import tls from 'node:tls'

const originHost = process.argv[2]
const originPort = Number(process.argv[3] ?? 9983)
const proxiedHost = process.argv[4]

if (!originHost || !Number.isInteger(originPort)) {
  console.error('用法: node scripts/check-origin-pull.mjs <源站主机> <回源端口> [橙云域名]')
  process.exit(2)
}

const TIMEOUT_MS = 10000

/** 纯 TCP 探测 */
function tcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = net.connect({ host, port })
    let done = false
    const finish = (state) => {
      if (done) return
      done = true
      clearTimeout(t)
      try { sock.destroy() } catch {}
      resolve({ state, ms: Date.now() - started })
    }
    const t = setTimeout(() => finish('timeout'), TIMEOUT_MS)
    sock.on('connect', () => finish('open'))
    sock.on('error', (e) => finish(e.code ?? 'error'))
  })
}

/** 探一下该端口是不是 TLS，并取证书信息 */
function probeTls(host, port) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(v)
    }
    const t = setTimeout(() => finish({ ok: false, why: '握手超时' }), TIMEOUT_MS)
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate()
      finish({
        ok: true,
        cn: c?.subject?.CN ?? '(无)',
        san: c?.subjectaltname ?? '',
        issuer: c?.issuer?.O ?? c?.issuer?.CN ?? '(未知)',
        selfSigned: c?.issuer?.CN === c?.subject?.CN,
        validTo: c?.valid_to ?? '',
      })
      sock.destroy()
    })
    sock.on('error', (e) => finish({ ok: false, why: e.code ?? e.message }))
  })
}

/** 用指定协议发一次真实请求（模拟 Cloudflare 回源时带的头） */
async function request(scheme, host, port, path = '/api/healthz') {
  const url = `${scheme}://${host}:${port}${path}`
  const started = Date.now()
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // 模拟 Cloudflare 回源时会带的东西
        'user-agent': 'Cloudflare',
        accept: 'application/json',
      },
      // 源站常用 Origin CA 自签证书，这里不去校验，只看能不能通
      dispatcher: undefined,
    })
    const body = await r.text()
    return { ok: true, status: r.status, ms: Date.now() - started, body: body.slice(0, 120) }
  } catch (e) {
    return { ok: false, why: e.cause?.code ?? e.message, ms: Date.now() - started }
  }
}

async function main() {
  console.log(`回源目标：${originHost}:${originPort}\n`)

  console.log('=== 1. TCP 可达性 ===')
  const t = await tcp(originHost, originPort)
  console.log(`  ${originPort} → ${t.state}  (${t.ms}ms)`)
  if (t.state !== 'open') {
    console.log('  ⚠ 端口都不通，Cloudflare 必然 522。先解决端口转发/防火墙，再谈协议。')
    return
  }

  console.log('')
  console.log('=== 2. 该端口是明文还是 TLS ===')
  const tlsInfo = await probeTls(originHost, originPort)
  if (tlsInfo.ok) {
    console.log(`  是 TLS`)
    console.log(`    CN      = ${tlsInfo.cn}`)
    console.log(`    颁发者  = ${tlsInfo.issuer}`)
    console.log(`    SAN     = ${tlsInfo.san}`)
    console.log(`    有效期至= ${tlsInfo.validTo}`)
    if (/Cloudflare/i.test(tlsInfo.issuer)) {
      console.log('    ✓ 颁发者是 Cloudflare —— 这是 Origin CA 证书，配 Full (strict) 正确')
    } else if (tlsInfo.selfSigned) {
      console.log('    ⚠ 自签证书：Full 可以，Full (strict) 会失败（Cloudflare 不认）')
    }
  } else {
    console.log(`  不是 TLS（${tlsInfo.why}）→ 源站是明文 HTTP`)
  }

  console.log('')
  console.log('=== 3. 两种协议分别请求一次 ===')
  // 注意：这里的结果只说明「源站讲哪种协议」。
  // 用 https 时 Node 会校验证书，而 Origin CA 证书**不在公共信任库里**，
  // 所以必然报 UNABLE_TO_VERIFY_LEAF_SIGNATURE —— 那是预期行为，不是故障：
  // 那张证书是签给 Cloudflare 看的，不是给浏览器/Node 看的。
  const httpRes = await request('http', originHost, originPort)
  console.log(
    httpRes.ok
      ? `  http  → HTTP ${httpRes.status}  (${httpRes.ms}ms)  ${httpRes.body}`
      : `  http  → 失败 ${httpRes.why}  (${httpRes.ms}ms)`,
  )

  const httpsRes = await request('https', originHost, originPort)
  if (httpsRes.ok) {
    console.log(`  https → HTTP ${httpsRes.status}  (${httpsRes.ms}ms)  ${httpsRes.body}`)
  } else if (httpsRes.why === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    // 握手本身是成功的，只是证书不被 Node 信任 —— 说明源站确实在讲 TLS
    console.log(`  https → 握手成功，证书未被公共信任库认可（预期）`)
    console.log(`          这说明源站确实在讲 TLS。具体是哪种证书见第 2 节。`)
  } else {
    console.log(`  https → 失败 ${httpsRes.why}  (${httpsRes.ms}ms)`)
  }

  console.log('')
  console.log('=== 4. 结论 ===')
  // 用源站自己的证书判断 Cloudflare 该用哪种模式，而不是看 Cloudflare 能不能连上
  // （Cloudflare 连不上时看不出来）。这两条互斥，逐跳核对时很有用。
  const originCertIsCf = tlsInfo.ok && /Cloudflare/i.test(tlsInfo.issuer)

  if (originCertIsCf) {
    console.log('  源站用的是 Cloudflare Origin CA 证书 → 模式**必须**是 Full (strict)')
    console.log('    （若还停在 Flexible，Cloudflare 会用 http 回源，而源站只讲 https → 522）')
  } else if (tlsInfo.ok) {
    console.log('  源站讲 TLS，但颁发者不是 Cloudflare，且你没配 Custom Origin Trust Store 的话，')
    console.log('  它是一张 Cloudflare 不认识的证书 → Full (strict) 会 526。')
    console.log('    改用 Full（不校验证书），或换成 Origin CA 证书')
  } else {
    console.log('  源站只讲明文 HTTP → 模式必须是 Flexible')
    console.log('    若你设了 Full / Full (strict)，要么改成 Flexible，')
    console.log('    要么给源站装 Cloudflare Origin CA 证书并启用 tls.*')
  }

  console.log('')
  console.log('  ⚠ 上面这段话只说明「模式该设成哪个」。')
  console.log('    若模式已经对了却仍然 522，问题就在**回源端口** ——')
  console.log(`    用 Rules → Origin Rules → Destination Port 指定 ${originPort}。`)
  if (tlsInfo.ok) {
    console.log('    若仍然 525/526，说明边缘用的协议与源站不符（模式与证书不一致）。')
  }

  if (proxiedHost) {
    console.log('')
    console.log(`=== 5. 完整链路：https://${proxiedHost} （走橙云标准 443）===`)
    const started = Date.now()
    try {
      const r = await fetch(`https://${proxiedHost}/api/healthz`, { signal: AbortSignal.timeout(30000) })
      const body = await r.text()
      console.log(`  HTTP ${r.status}  (${Date.now() - started}ms)`)
      console.log(`  server=${r.headers.get('server')}  cf-ray=${r.headers.get('cf-ray')}`)
      console.log(`  body: ${body.slice(0, 140)}`)
      if (r.status === 200 && body.includes('"ok"')) {
        console.log('  ✓✓ 打通了')
      } else if (r.status === 522) {
        console.log('  ✗ 仍是 522：边缘连不上源站。回到第 4 节的结论继续处理。')
      }
    } catch (e) {
      console.log(`  失败：${e.cause?.code ?? e.message}  (${Date.now() - started}ms)`)
    }
  }
}

main()
