/**
 * 预部署校验：把服务端的裁剪逻辑在**真实上游数据**上跑一遍。
 *
 * 检查四件事：
 *   1. 裁剪后的字段集合与预期一致（不多不少）
 *   2. main_rank(30) + second_rank(80) 都在，合计 110 条
 *   3. 体积省了多少（含 gzip）
 *   4. 用裁剪后的数据复算「排名定位」，确认不再被截断在 30 名
 *
 * 字段清单从 `server/weekly.go` 里读（**不是**从已停用的 worker/index.js），
 * 因为周刊转发现在由 Go 后端承担。
 *
 * 与 Go 测试的分工：Go 那边用假上游验证逻辑；这里用**真实上游响应**验证
 * 线上数据的形状与体积 —— 上游改了字段名的话，只有这个脚本能发现。
 *
 * 用法：node scripts/verify-trim.mjs
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const UPSTREAM = 'https://www.evocalrank.com/data/info/latest.json'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

// ── 1. 从 Go 源码里抠出真实使用的字段清单，避免两边不一致 ──
function readFieldsFromGo(file) {
  const src = readFileSync(file, 'utf8')
  const m = src.match(/var\s+VIDEO_FIELDS\s*=\s*\[\]string\{([\s\S]*?)\n\}/)
  if (!m) return null
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

const fields = readFieldsFromGo('server/weekly.go')
if (!fields) {
  console.error('✗ 在 server/weekly.go 中找不到 VIDEO_FIELDS')
  console.error('  若改名了，请同步更新本脚本的匹配规则。')
  process.exit(1)
}
console.log('① 服务端保留的字段（从 server/weekly.go 读取，非硬编码）')
console.log('   ' + fields.join(', '))

const EXPECTED = [
  'url',
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
if (JSON.stringify(fields) !== JSON.stringify(EXPECTED)) {
  console.error('✗ 字段清单与预期不符')
  console.error('   期望: ' + EXPECTED.join(', '))
  process.exit(1)
}
console.log('   ✓ 含标题(title)、排名(rank)、av号(avid)、链接(url)')
console.log('   ✓ 不含 referSource / coverurl / pubdate / share 等冗余字段')

// 顺带确认 Go 那边的裁剪逻辑与这里一致（同为「字段存在才输出」）
const goSrc = readFileSync('server/weekly.go', 'utf8')
if (!goSrc.includes('exists') || !goSrc.includes('raw == nil')) {
  console.log('   ⚠ 没在 Go 源码里找到「字段不存在则跳过」的判断，请人工确认裁剪语义')
}

// ── 2. 抓真实数据并裁剪 ──
const res = await fetch(UPSTREAM, { headers: { 'User-Agent': UA } })
if (!res.ok) {
  console.error(`✗ 上游返回 HTTP ${res.status}`)
  process.exit(1)
}
const raw = await res.text()
const original = JSON.parse(raw)

function trimVideo(v) {
  const o = {}
  for (const f of fields) if (v?.[f] !== undefined) o[f] = v[f]
  return o
}
const trimmed = {
  ranknum: original.ranknum,
  generate_time: original.generate_time,
  collect_start_time: original.collect_start_time,
  collect_end_time: original.collect_end_time,
  main_rank: (original.main_rank ?? []).map(trimVideo),
  second_rank: (original.second_rank ?? []).map(trimVideo),
}
const trimmedStr = JSON.stringify(trimmed)

console.log('')
console.log('② 榜单完整性')
console.log(`   main_rank   ${trimmed.main_rank.length} 条`)
console.log(`   second_rank ${trimmed.second_rank.length} 条`)
const total = trimmed.main_rank.length + trimmed.second_rank.length
console.log(`   合计        ${total} 条`)
if (total !== 110) {
  console.error('✗ 合计不是 110 条')
  process.exit(1)
}

// 名次必须连续覆盖 1..110
const ranks = [...trimmed.main_rank, ...trimmed.second_rank].map((v) => v.rank)
console.log(`   名次范围    ${Math.min(...ranks)} ~ ${Math.max(...ranks)}，去重后 ${new Set(ranks).size} 个`)
if (new Set(ranks).size !== 110 || Math.min(...ranks) !== 1 || Math.max(...ranks) !== 110) {
  console.error('✗ 名次未连续覆盖 1~110')
  process.exit(1)
}

// ── 3. 体积 ──
const origGz = gzipSync(raw).length
const trimGz = gzipSync(trimmedStr).length
console.log('')
console.log('③ 体积')
console.log(`   原始    ${(raw.length / 1024).toFixed(1)} KB   gzip 后 ${(origGz / 1024).toFixed(1)} KB`)
console.log(`   裁剪后  ${(trimmedStr.length / 1024).toFixed(1)} KB   gzip 后 ${(trimGz / 1024).toFixed(1)} KB`)
console.log(`   省下    ${((raw.length - trimmedStr.length) / 1024).toFixed(1)} KB (${((1 - trimmedStr.length / raw.length) * 100).toFixed(0)}%)  ` +
  `gzip 省 ${((origGz - trimGz) / 1024).toFixed(1)} KB (${((1 - trimGz / origGz) * 100).toFixed(0)}%)`)

// ── 4. 用裁剪后的数据复算排名定位 ──
console.log('')
console.log('④ 用裁剪后的数据复算排名定位（验证不再被 30 名截断）')

// 组件里的判定方式：数「有多少条得点更高」+1。与数组顺序、并列都无关。
const byPointDesc = [...trimmed.main_rank, ...trimmed.second_rank].sort((a, b) => b.point - a.point)
const wouldRank = (t) => byPointDesc.filter((v) => v.point > t).length + 1

// 构造期望值：按得点降序排序后，第 i 条（下标 i）在无并列时的名次就是 i+1。
// 这里直接用同一判据算出期望，验证的是「合并后能覆盖到 110」这件事本身。
const cases = [
  ['主榜榜首之上', byPointDesc[0].point + 1000, 1],
  ['主榜第 1 名本身', byPointDesc[0].point, 1],
  ['主榜第 5 名本身', byPointDesc[4].point, 5],
  ['续榜第 1 条（rank 31）', byPointDesc.find((v) => v.rank === 31).point, 0],
  ['榜尾（rank 110）', byPointDesc[byPointDesc.length - 1].point, 0],
]
let bad = 0
for (const [label, total_, expect] of cases) {
  const got = wouldRank(total_)
  // expect 为 0 表示「按统一判据动态核对」，因为并列会让绝对值不可预测
  const ok = expect === 0 ? got > 30 : got === expect
  if (!ok) bad++
  const shown = expect === 0 ? '>30' : String(expect)
  console.log(
    `   ${label.padEnd(22)} 得点 ${String(Math.round(total_)).padEnd(9)} → 第 ${String(got).padStart(3)} 位  (期望 ${shown})  ${ok ? '✓' : '✗'}`,
  )
}

// 关键回归断言：续榜与榜尾的名次必须超出 30，这正是修复前做不到的
const rank31 = wouldRank(byPointDesc.find((v) => v.rank === 31).point)
const rankLast = wouldRank(byPointDesc[byPointDesc.length - 1].point)
if (rank31 <= 30 || rankLast <= 30) {
  console.error('✗ 排名未突破 30 名上限，修复无效')
  bad++
}
console.log('')
console.log(`   rank 31 的视频定位在第 ${rank31} 位、rank 110 的定位在第 ${rankLast} 位 —— 均超出旧上限 30 ✓`)

// 并列情况（说明为何不能按下标推算名次）
const dup = new Set()
const seen = new Map()
for (const v of byPointDesc) {
  if (seen.has(v.point)) dup.add(v.point)
  seen.set(v.point, true)
}
console.log(`   榜单中存在并列得点 ${dup.size} 处${dup.size ? '（' + [...dup].slice(0, 3).join(', ') + '…）' : ''}`)

// 旧行为对照
const legacy = trimmed.main_rank.filter((v) => v.point > rank31).length + 1
console.log('')
console.log(`   若只用 main_rank（旧 bug），rank 31 的得分会被报成第 ${legacy} 位 —— 这就是之前的问题`)

console.log('')
if (bad === 0) {
  console.log('✅ 裁剪逻辑正确，字段与体积符合预期，排名可覆盖 1~110')
} else {
  console.log(`❌ 有 ${bad} 项判定不符`)
  process.exit(1)
}
