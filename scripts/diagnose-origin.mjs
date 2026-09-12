/**
 * 诊断 Cloudflare 回源（522）到底是「端口不对」还是「协议不对」。
 *
 * 背景：源站 9983 从外部可达（已实测），但 Cloudflare 走橙云进来是 522。
 * 522 的含义是「边缘连不上源站」，所以只剩两种可能：
 *   A. 回源端口不是 9983（你可能只在路由器转发了 9983）
 *   B. 回源用了 HTTPS，而源站是明文 HTTP（SSL/TLS 模式为 Full / Full (strict)）
 *
 * 这个脚本从外部把「源站各端口 + 协议」的实际情况列出来，
 * 你拿去和 Cloudflare 面板里的设置对一下就知道是哪种。
 *
 * 用法：node scripts/diagnose-origin.mjs mc.tbpdt.top 9983
 */

import net from 'node:net'
import tls from 'node:tls'

const host = process.argv[2] ?? 'mc.tbpdt.top'
const originPort = Number(process.argv[3] ?? 9983)

/** 纯 TCP 能否连上 */
function tcp(host, port, ms = 8000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (state) => {
      if (done) return
      done = true
      clearTimeout(t)
      try { sock.destroy() } catch {}
      resolve(state)
    }
    const t = setTimeout(() => finish('超时（被丢包）'), ms)
    sock.on('connect', () => finish('可连'))
    sock.on('error', (e) => finish(e.code === 'ECONNREFUSED' ? '拒绝（端口通但无监听）' : e.code))
  })
}

/** 该端口是不是 TLS */
function isTls(host, port, ms = 8000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(v)
    }
    const t = setTimeout(() => finish('超时'), ms)
    const sock = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false },
      () => {
        const cert = sock.getPeerCertificate()
        finish(`是 TLS（证书 CN=${cert?.subject?.CN ?? '?'} 颁发者=${cert?.issuer?.O ?? cert?.issuer?.CN ?? '?'}）`)
        sock.destroy()
      },
    )
    sock.on('error', (e) => {
      // 明文端口收到 TLS 握手时，通常报这几类错
      const m = String(e.code ?? e.message)
      finish(`不是 TLS（${m}）`)
    })
  })
}

/** 用明文 HTTP 取一次，确认业务真的活着 */
async function plainHttp(host, port, ms = 8000) {
  try {
    const r = await fetch(`http://${host}:${port}/api/healthz`, { signal: AbortSignal.timeout(ms) })
    const body = await r.text()
    return `HTTP ${r.status}  ${body.slice(0, 90)}`
  } catch (e) {
    return `失败：${e.cause?.code ?? e.message}`
  }
}

async function main() {
  console.log(`源站：${host}\n`)

  console.log('=== 1. 各端口的 TCP 与协议 ===')
  for (const port of [80, 443, originPort, 8443]) {
    const t = await tcp(host, port)
    let extra = ''
    if (t === '可连') {
      extra = await isTls(host, port)
    }
    console.log(`  端口 ${String(port).padEnd(6)} TCP: ${t.padEnd(22)} ${extra}`)
  }

  console.log('')
  console.log(`=== 2. 源站业务是否活着（明文 HTTP :${originPort}）===`)
  console.log(`  ${await plainHttp(host, originPort)}`)

  console.log('')
  console.log('=== 3. 结论怎么读 ===')
  console.log('  · 只有', originPort, '可连、其他都超时 → 路由器只转发了这一个端口。')
  console.log('    那么 Cloudflare 若回源到 80/443，必然 522。')
  console.log('  · 端口可连但「不是 TLS」→ 源站是明文 HTTP。')
  console.log('    若 Cloudflare 的 SSL/TLS 模式是 Full / Full (strict)，它会用 HTTPS 回源 → 522。')
  console.log('')
  console.log('  → 对应两种修法：')
  console.log('    A. 把 SSL/TLS 模式设成 Flexible（Cloudflare 用 http 回源；9983 是明文，所以通）')
  console.log('    B. 保持 Full (strict)，给源站装 Cloudflare Origin CA 证书并启用 HTTPS')
  console.log('       两种都可以；B 更安全，A 改一下面板就能立刻通。')
  console.log('')
  console.log('  若两种都试过仍 522，用 Rules → Origin Rules → Destination Port 显式指定', originPort, '。')
}

main()
