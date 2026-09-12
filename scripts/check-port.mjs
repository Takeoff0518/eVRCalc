/**
 * 从外网探测某个主机端口的可达性。
 *
 * 用途：走 Cloudflare 代理时，最常见的失败是「家里那个回源端口其实不通」。
 * 云端的 Cloudflare 连不上你家，界面上只会得到 522/521 这类含义模糊的错误。
 * 先用这个脚本从**外部**确认端口是否真的开放，可以省掉一大圈排查。
 *
 * 用法：
 *   node scripts/check-port.mjs mc.tbpdt.top 8443
 *   node scripts/check-port.mjs mc.tbpdt.top 8443 9983 2053
 *
 * 判读：
 *   · 开放        → 端口通了，问题在 Cloudflare 侧（回源端口没配对、SSL 模式等）
 *   · 拒绝        → 端口没被封，但**没有程序在监听**（后端没起或没绑对地址）
 *   · 超时        → 多半被运营商/防火墙丢包，或路由器没做端口转发
 *   · 域名解析不到 → DNS 或 ddns-go 的问题
 *
 * 注意：必须**从外网**跑才有意义。在家里同一台机器上跑，连的是内网地址，
 * 会得到"开放"的假阳性。这个脚本在你本地跑就是外网视角，正好适用。
 */

import net from 'node:net'
import dns from 'node:dns/promises'

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 8000)

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error('用法: node scripts/check-port.mjs <主机> <端口> [端口...]')
  console.error('例:   node scripts/check-port.mjs mc.tbpdt.top 8443')
  process.exit(2)
}

const host = args[0]
const ports = args.slice(1).map((p) => {
  const n = Number(p)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`非法端口：${p}`)
    process.exit(2)
  }
  return n
})

function probe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = net.connect({ host, port })
    let settled = false
    const finish = (state) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {}
      resolve({ state, ms: Date.now() - started })
    }
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)
    sock.on('connect', () => finish('open'))
    sock.on('timeout', () => finish('timeout'))
    sock.on('error', (e) => finish(e.code ?? 'error'))
  })
}

function verdict(state) {
  switch (state) {
    case 'open':
      return { mark: '开放', hint: '端口可达 —— 若 Cloudflare 仍报错，问题在回源端口配置或 SSL 模式' }
    case 'ECONNREFUSED':
      return { mark: '拒绝', hint: '端口没被封，但没有程序监听：确认后端在跑、且 listen 绑到了 0.0.0.0 而不是 127.0.0.1' }
    case 'timeout':
      return { mark: '超时', hint: '多半被运营商/防火墙丢包，或路由器没有转发这个端口' }
    case 'ENOTFOUND':
      return { mark: '域名不存在', hint: 'DNS 解析失败：检查 A 记录与 ddns-go' }
    case 'EHOSTUNREACH':
      return { mark: '主机不可达', hint: 'IP 不对，或对端网络不通' }
    default:
      return { mark: state, hint: '未知错误' }
  }
}

async function main() {
  console.log(`外部视角探测：${host}\n`)

  let ips = []
  try {
    ips = await dns.resolve4(host)
    console.log(`  解析到 ${ips.join(', ')}\n`)
  } catch (e) {
    console.log(`  DNS 解析失败：${e.code}\n`)
  }

  let ok = 0
  for (const port of ports) {
    const r = await probe(host, port)
    const v = verdict(r.state)
    const mark = r.state === 'open' ? '✓' : '✗'
    if (r.state === 'open') ok++
    console.log(`${mark} 端口 ${String(port).padEnd(6)} ${v.mark.padEnd(10)} ${String(r.ms).padStart(5)}ms`)
    console.log(`    ${v.hint}`)
  }

  console.log(`\n${ok}/${ports.length} 个端口开放。`)
  if (ok === 0) {
    console.log('\n提示：后端要监听所有网卡（listen: ":8443"），只绑 127.0.0.1 的话外网连不上。')
    console.log('      另外确认路由器/防火墙做了 8443 的端口转发。')
    process.exitCode = 1
  }
}

main()
