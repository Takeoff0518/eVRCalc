/**
 * 跨平台的后端构建入口。
 *
 * 存在的理由：`server/build.ps1` 在 Windows 上好用、`server/build.sh` 在
 * Linux/macOS 上好用，但 npm scripts 里的 shell 语法两边不通用。
 * 这里用一个 Node 脚本做分发，于是 `npm run server:build` 在哪个平台都成立。
 *
 * 用法：
 *   node scripts/build-server.mjs                 # 默认 linux-amd64
 *   node scripts/build-server.mjs linux-arm64
 *   node scripts/build-server.mjs all
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'server')
const target = process.argv[2] ?? 'linux-amd64'

if (!existsSync(serverDir)) {
  console.error(`找不到后端目录：${serverDir}`)
  process.exit(1)
}

try {
  if (process.platform === 'win32') {
    // 注意：必须用 powershell.exe 而不是 pwsh —— Windows 自带的 5.1 就够了，
    // 而 build.ps1 刻意写成纯 ASCII，正是为了绕开 5.1 把无 BOM 的 UTF-8
    // 当 GBK 读的那个老坑。
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(serverDir, 'build.ps1'), target],
      { stdio: 'inherit', cwd: serverDir },
    )
  } else {
    execFileSync('bash', [join(serverDir, 'build.sh'), target], { stdio: 'inherit', cwd: serverDir })
  }
} catch (err) {
  console.error(`\n后端构建失败（目标 ${target}）`)
  console.error(err?.message ?? err)
  console.error('\n常见原因：Go 环境取不到依赖源码。可以设 GOPROXY 后重试：')
  console.error('  $env:GOPROXY="https://goproxy.cn,direct"   # PowerShell')
  console.error('  或者在 server/ 里跑一次 go mod vendor 之后完全离线构建')
  process.exit(1)
}
