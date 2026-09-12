/**
 * 把源站 TLS 证书的完整信息读出来，并逐项核对 Cloudflare 会怎么判断。
 *
 * 用途：橙云报 526（Invalid SSL certificate）时，Cloudflare 只说"证书无效"，
 * 不说为什么。这个脚本从外部把证书的真实内容打出来，重点核对两件事：
 *   1. 证书里到底有哪些 SAN —— **有没有覆盖你正在用的那个域名**
 *   2. 颁发者是不是 Cloudflare 的 Origin CA（Full (strict) 只认这个）
 *
 * 用法：
 *   node scripts/inspect-cert.mjs mc.tbpdt.top 9983 api2.tbpdt.top
 */

import tls from 'node:tls'

const host = process.argv[2]
const port = Number(process.argv[3] ?? 9983)
const expectHost = process.argv[4] // 希望被证书覆盖的域名

if (!host) {
  console.error('用法: node scripts/inspect-cert.mjs <主机> [端口] [要核对的域名]')
  process.exit(2)
}

/** 判断某个主机名是否被证书覆盖（支持通配符） */
function covers(sanList, hostname) {
  const h = hostname.toLowerCase()
  for (const raw of sanList) {
    const entry = raw.toLowerCase().replace(/^dns:/, '').trim()
    if (!entry) continue
    if (entry === h) return `精确匹配 ${entry}`
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // ".tbpdt.top"
      if (h.endsWith(suffix)) {
        // 通配符只覆盖**一级**子域
        const label = h.slice(0, -suffix.length)
        if (label && !label.includes('.')) return `通配符匹配 ${entry}`
        return `✗ 通配符 ${entry} 只覆盖一级子域，覆盖不到 ${h}`
      }
    }
  }
  return null
}

function readCert() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate(true) // true = 含完整链
      const proto = sock.getProtocol()
      const cipher = sock.getCipher()
      sock.destroy()
      resolve({ c, proto, cipher })
    })
    sock.on('error', reject)
    sock.setTimeout(10000, () => {
      sock.destroy()
      reject(new Error('超时'))
    })
  })
}

async function main() {
  console.log(`读取 ${host}:${port} 的证书\n`)

  let info
  try {
    info = await readCert()
  } catch (e) {
    console.error(`连接失败：${e.message}`)
    process.exit(1)
  }

  const c = info.c
  console.log('=== 协议与套件 ===')
  console.log(`  协议    ${info.proto}`)
  console.log(`  套件    ${info.cipher?.name ?? '(未知)'}`)

  console.log('')
  console.log('=== 证书主体 ===')
  console.log(`  Subject   ${JSON.stringify(c.subject)}`)
  console.log(`  Issuer    ${JSON.stringify(c.issuer)}`)
  console.log(`  序列号    ${c.serialNumber}`)
  console.log(`  生效      ${c.valid_from}`)
  console.log(`  到期      ${c.valid_to}`)

  console.log('')
  console.log('=== Subject Alternative Names（最关键）===')
  const raw = c.subjectaltname ?? ''
  console.log(`  原始值    ${raw === '' ? '(空！)' : raw}`)
  const sans = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (sans.length === 0) {
    console.log('')
    console.log('  ⚠ 证书里**没有任何 SAN**。现代 TLS 客户端（含 Cloudflare）')
    console.log('    只看 SAN、不看 CN。没有 SAN 的证书会被判为无效 → 526。')
  } else {
    console.log('  逐项：')
    for (const s of sans) console.log(`    · ${s}`)
  }

  console.log('')
  console.log('=== 链 ===')
  let cur = c
  let depth = 0
  while (cur && depth < 6) {
    const sub = cur.subject?.CN ?? '?'
    const iss = cur.issuer?.CN ?? '?'
    console.log(`  [${depth}] subject=${sub}  issuer=${iss}`)
    const next = cur.issuerCertificate
    if (!next || next === cur || !next.subject) break
    cur = next
    depth++
  }

  console.log('')
  console.log('=== 颁发者判定 ===')
  const issuerStr = JSON.stringify(c.issuer)
  if (/cloudflare/i.test(issuerStr)) {
    console.log('  ✓ 颁发者是 Cloudflare —— Origin CA 证书，Full (strict) 应该接受')
  } else {
    console.log('  ✗ 颁发者不是 Cloudflare。Full (strict) 只认 Cloudflare Origin CA')
    console.log('    → 要么换成 Origin CA 证书，要么把模式改成 Full（不校验证书）')
  }

  if (expectHost) {
    console.log('')
    console.log(`=== 覆盖检查：${expectHost} ===`)
    const verdict = covers(sans, expectHost)
    if (verdict && verdict.startsWith('✗')) {
      console.log(`  ${verdict}`)
      console.log('')
      console.log('  ← 这就是 526 的原因。到 Cloudflare 面板重新签一张证书：')
      console.log('     SSL/TLS → Origin Server → Origin Certificates → Create Certificate')
      console.log('     Hostnames 填：*.tbpdt.top, tbpdt.top')
      console.log('     （通配符 *.tbpdt.top 覆盖一级子域，api2.tbpdt.top 属于一级子域，能覆盖）')
    } else if (verdict) {
      console.log(`  ✓ ${verdict}`)
      console.log('    证书覆盖该域名。若仍 526，问题在别处（见下面的核对清单）')
    } else {
      console.log(`  ✗ 证书里没有覆盖 ${expectHost} 的条目 → Cloudflare 会拒绝（526）`)
      console.log('')
      console.log('    重新签一张，Hostnames 填：*.tbpdt.top, tbpdt.top')
    }
  }

  console.log('')
  console.log('=== 若 SAN 正确却仍 526，逐个核对这些 ===')
  console.log('  1. SSL/TLS 模式确实是 Full (strict)（不是 Full、不是 Flexible）')
  console.log('  2. 证书的**私钥**与证书是一对（重新签发后忘了换私钥会 526）')
  console.log('  3. 证书没过期（上面有到期时间）')
  console.log('  4. 回源用的 SNI 是 api2.tbpdt.top（Origin Rule 若改了 Host 头会连带改 SNI）')
  console.log('  5. 中间证书缺失：cert_file 要用 **fullchain** 而不是单独的 cert')
}

main()
