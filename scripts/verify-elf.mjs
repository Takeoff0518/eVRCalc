/**
 * 校验交叉编译产物的架构与链接方式。
 *
 * 为什么需要它：交叉编译最常见的两种翻车方式是
 *   1. 架构编错 → 上机直接 `Exec format error`
 *   2. 动态链接 → 老系统上报 `GLIBC_2.x not found`
 * 两者都能在本地就看出来，没必要 scp 上去才发现。
 *
 * 用法：
 *   node scripts/verify-elf.mjs                     # 检查 server/dist 下所有产物
 *   node scripts/verify-elf.mjs path/to/binary      # 检查指定文件
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'server', 'dist')

// ELF e_machine 取值 → 架构名
const ELF_MACHINES = {
  0x03: 'i386 (x86)',
  0x28: 'ARM (32 位)',
  0x3e: 'x86-64',
  0xb7: 'AArch64 (ARM64)',
}
// PE Machine 取值 → 架构名
const PE_MACHINES = {
  0x014c: 'i386 (x86)',
  0x8664: 'x86-64',
  0xaa64: 'AArch64 (ARM64)',
}

function describeElf(buf) {
  const cls = buf[4]
  const endian = buf[5]
  const machine = endian === 1 ? buf.readUInt16LE(0x12) : buf.readUInt16BE(0x12)
  const arch = ELF_MACHINES[machine] ?? `未知 (0x${machine.toString(16)})`

  // 程序头表：找 PT_INTERP(3)。有它就意味着动态链接。
  let hasInterp = false
  if (cls === 2) {
    const phoff = Number(buf.readBigUInt64LE(0x20))
    const phentsize = buf.readUInt16LE(0x36)
    const phnum = buf.readUInt16LE(0x38)
    for (let i = 0; i < phnum; i++) {
      const type = buf.readUInt32LE(phoff + i * phentsize)
      if (type === 3) hasInterp = true
    }
  }

  return {
    format: `ELF ${cls === 2 ? '64' : '32'} 位${endian === 1 ? '小端' : '大端'}`,
    arch,
    static: !hasInterp,
    // 后缀名里声明的目标，用来交叉比对
    expected: null,
  }
}

function describePe(buf) {
  const peOff = buf.readUInt32LE(0x3c)
  const machine = buf.readUInt16LE(peOff + 4)
  return {
    format: 'PE (Windows)',
    arch: PE_MACHINES[machine] ?? `未知 (0x${machine.toString(16)})`,
    static: true, // Go 的 Windows 二进制默认不依赖外部 DLL
    expected: null,
  }
}

// Mach-O（macOS）。Go 默认生成 64 位 Mach-O。
const MACHO_CPUS = {
  0x01000007: 'x86-64',
  0x0100000c: 'AArch64 (ARM64)',
}

function describeMachO(buf) {
  const magic = buf.readUInt32LE(0)
  const is64 = magic === 0xfeedfacf
  const cputype = buf.readUInt32LE(4)
  return {
    format: `Mach-O ${is64 ? '64' : '32'} 位${magic === 0xfeedfacf || magic === 0xfeedface ? '小端' : '大端'}`,
    arch: MACHO_CPUS[cputype] ?? `未知 (0x${cputype.toString(16)})`,
    // macOS 上 Go 的动态链接已由系统保证，这里不做静态性判断
    static: true,
    expected: null,
  }
}

/** 判断是不是 Mach-O（含 fat/universal 变体） */
function machoMagic(buf) {
  if (buf.length < 4) return null
  const le = buf.readUInt32LE(0)
  const be = buf.readUInt32BE(0)
  // 32/64 位单架构，大小端两种写法
  if (le === 0xfeedface || le === 0xfeedfacf) return 'le'
  if (be === 0xfeedface || be === 0xfeedfacf) return 'be'
  // fat / universal binary
  if (be === 0xcafebabe || be === 0xcafebabf) return 'fat'
  return null
}

/** 从文件名推断声明的目标，用于交叉比对 */
function expectedFromName(name) {
  if (name.includes('linux-amd64')) return 'x86-64'
  if (name.includes('linux-arm64')) return 'AArch64 (ARM64)'
  if (name.includes('linux-armv7')) return 'ARM (32 位)'
  if (name.includes('linux-386')) return 'i386 (x86)'
  if (name.includes('windows-amd64')) return 'x86-64'
  if (name.includes('darwin-arm64')) return 'AArch64 (ARM64)'
  if (name.includes('darwin-amd64')) return 'x86-64'
  return null
}

const args = process.argv.slice(2)
let files

if (args.length > 0) {
  files = args
} else {
  if (!existsSync(distDir)) {
    console.error(`找不到产物目录：${distDir}`)
    console.error('先跑一次 npm run server:build，或 npm run server:build:all')
    process.exit(1)
  }
  files = readdirSync(distDir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => join(distDir, f))
}

if (files.length === 0) {
  console.error('没有可检查的产物。')
  process.exit(1)
}

let failed = 0

for (const file of files) {
  const name = file.split(/[\\/]/).pop()
  let buf
  try {
    buf = readFileSync(file)
  } catch (err) {
    console.log(`✗ ${name}\n    无法读取: ${err.message}`)
    failed++
    continue
  }

  let info
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    info = describeElf(buf)
  } else if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    info = describePe(buf)
  } else if (machoMagic(buf) === 'le') {
    info = describeMachO(buf)
  } else if (machoMagic(buf) === 'fat') {
    info = { format: 'Mach-O fat/universal', arch: '多架构', static: true, expected: null }
  } else {
    console.log(`✗ ${name}\n    无法识别的格式（既不是 ELF、PE，也不是 Mach-O）`)
    failed++
    continue
  }

  const expected = expectedFromName(name)
  const archOk = !expected || info.arch === expected
  const linkNote = info.format.startsWith('ELF')
    ? info.static
      ? '静态链接 ✓'
      : '动态链接 ✗（老系统可能报 GLIBC 版本错误）'
    : '—'

  const size = (buf.length / 1024 / 1024).toFixed(2)
  const mark = archOk && info.static ? '✓' : '✗'
  if (mark === '✗') failed++

  console.log(`${mark} ${name}`)
  console.log(`    ${info.format} · ${info.arch} · ${linkNote} · ${size} MB`)
  if (!archOk) {
    console.log(`    ⚠ 文件名声明的架构是「${expected}」，但实际是「${info.arch}」`)
  }
}

console.log('')
if (failed > 0) {
  console.log(`${failed} 个产物有问题。`)
  process.exitCode = 1
} else {
  console.log(`全部 ${files.length} 个产物校验通过。`)
  console.log('提示：上机后可用 `uname -m` 确认目标架构与之相符。')
}
