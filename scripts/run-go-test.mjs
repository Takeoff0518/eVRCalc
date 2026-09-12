/**
 * 运行后端 Go 测试。
 *
 * 除了转发参数，还负责一件事：**把 Go 的构建缓存指到工作区内**。
 * 本机 `%TEMP%` 与 `D:\nodejs\go-build` 都不可写（沙箱 + 安全软件会拦），
 * 不设这几个变量时 `go test` 会以
 * "failed to initialize build cache ... Access is denied" 失败。
 * 在正常机器上这些变量指到工作区也无害。
 *
 * 用法：
 *   node scripts/run-go-test.mjs              # 全部测试
 *   node scripts/run-go-test.mjs -run TestAvToBv -v
 *   EVRC_LIVE=1 node scripts/run-go-test.mjs  # 额外跑需要联网的交叉验证
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'server')

if (!existsSync(serverDir)) {
  console.error(`找不到后端目录：${serverDir}`)
  process.exit(1)
}

const env = {
  ...process.env,
  // 缓存落在工作区，避开不可写的系统临时目录
  GOCACHE: process.env.GOCACHE ?? join(root, '.gocache'),
  GOMODCACHE: process.env.GOMODCACHE ?? join(root, '.gomodcache'),
  GOTMPDIR: process.env.GOTMPDIR ?? join(root, '.gotmp'),
  // proxy.golang.org 在本机不可达；走镜像。已经 vendor 过的话用不上
  GOPROXY: process.env.GOPROXY ?? 'https://goproxy.cn,direct',
  GOSUMDB: process.env.GOSUMDB ?? 'off',
}

const args = process.argv.slice(2)
const goArgs = args.length > 0 ? ['test', ...args, '.'] : ['test', './...']

try {
  execFileSync(process.platform === 'win32' ? 'go.exe' : 'go', goArgs, {
    stdio: 'inherit',
    cwd: serverDir,
    env,
  })
} catch {
  // go test 已经把失败详情打进 stderr 了，这里不重复啰嗦
  process.exit(1)
}
