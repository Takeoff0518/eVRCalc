/**
 * 把源站证书的原始内容解析出来，重点确认 SAN。
 *
 * 为什么要单独做这个：Node 的 getPeerCertificate() 有时会漏报扩展字段。
 * 判 526 之前必须排除"是解析器的锅"，所以这里用**另一条路径**再解析一次 ——
 * Node 内置的 X509Certificate（与 getPeerCertificate 是两套独立实现）。
 *
 * 用法：node scripts/dump-cert.mjs mc.tbpdt.top 9983
 */

import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'

const host = process.argv[2]
const port = Number(process.argv[3] ?? 9983)

function grab() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const der = sock.getPeerCertificate(true)?.raw
      sock.destroy()
      resolve(der)
    })
    sock.on('error', reject)
    sock.setTimeout(10000, () => {
      sock.destroy()
      reject(new Error('超时'))
    })
  })
}

function toPem(der) {
  const b64 = der.toString('base64')
  const lines = b64.match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
}

async function main() {
  const der = await grab()
  if (!der) {
    console.error('拿不到证书（服务端可能没发证书）')
    process.exit(1)
  }
  console.log(`证书 DER 长度：${der.length} 字节`)

  // 独立解析路径：Node 的 X509Certificate
  const cert = new X509Certificate(der)

  console.log('')
  console.log('=== Node X509Certificate 解析（独立于 getPeerCertificate）===')
  console.log(`  subject        ${cert.subject.replace(/\n/g, ', ')}`)
  console.log(`  issuer         ${cert.issuer.replace(/\n/g, ', ')}`)
  console.log(`  validFrom      ${cert.validFrom}`)
  console.log(`  validTo        ${cert.validTo}`)
  console.log(`  serialNumber   ${cert.serialNumber}`)
  console.log(`  keyType        ${cert.asymmetricKeyType ?? '(未知)'}`)
  console.log(`  subjectAltName ${JSON.stringify(cert.subjectAltName ?? null)}`)
  console.log(`  infoAccess     ${JSON.stringify(cert.infoAccess ?? null)}`)

  // 逐条列出 SAN
  const san = cert.subjectAltName ?? ''
  console.log('')
  console.log('=== SAN 逐条 ===')
  if (!san.trim()) {
    console.log('  (空 —— 证书里没有任何 SAN)')
  } else {
    for (const part of san.split(',')) {
      const p = part.trim()
      if (p) console.log(`  · ${p}`)
    }
  }

  console.log('')
  console.log('=== 用 TLS 客户端的方式验证主机名 ===')
  // checkHost 是 Node 内部用于校验主机名的同一套逻辑
  const target = process.argv[4] ?? host
  try {
    const ok = cert.checkHost(target)
    if (ok) {
      console.log(`  ✓ checkHost("${target}") 通过：${ok}`)
    } else {
      console.log(`  ✗ checkHost("${target}") 返回空 —— 证书不覆盖该域名`)
    }
  } catch (e) {
    console.log(`  ✗ checkHost("${target}") 失败：${e.message}`)
    console.log('    （这一般就是没有 SAN 导致的）')
  }

  console.log('')
  console.log('=== 用 PEM 原文再做一次（第三方实现，交叉验证）===')
  console.log('  下面这段可以直接粘到任何在线/本地 openssl 里看：')
  console.log('    openssl x509 -noout -ext subjectAltName -in peer.pem')
  const pem = toPem(der)
  console.log('')
  console.log(pem.split('\n').slice(0, 4).join('\n'))
  console.log('  ...')
  console.log('')

  console.log('=== 结论 ===')
  const hasSan = Boolean(san.trim())
  const issuerIsCf = /cloudflare/i.test(cert.issuer)
  if (!hasSan) {
    console.log('  ✗ 证书**没有 SAN**。现代 TLS 客户端（含 Cloudflare）只看 SAN、不看 CN，')
    console.log('    所以这张证书会被判为无效 → 526。')
    console.log('')
    console.log('  重新签一张带 hostname 的 Origin CA 证书即可。')
  } else if (!issuerIsCf) {
    console.log('  ✗ SAN 有，但颁发者不是 Cloudflare。Full (strict) 只认 Cloudflare Origin CA。')
  } else {
    console.log('  ✓ 有 SAN 且颁发者是 Cloudflare。若仍 526，问题在别处。')
  }
}

main()
