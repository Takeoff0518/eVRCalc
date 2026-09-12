/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 本地开发时，/api 走 dev proxy 打到后端，浏览器只看到同源请求，
// 因此本地也能跑通联网功能，且不需要配 CORS。
//
// 默认目标是本地跑起来的 Go 后端（server/server.yaml 里 listen: ":9983"）。
// 也可以指向线上：
//   $env:VITE_API_TARGET="https://mc.tbpdt.top:9983"; npm run dev
//
// 注意 changeOrigin 会把 Host 改掉，浏览器发出的 Origin 不会透传到后端 ——
// 这正是 B 站 WAF 放行的关键（它拒绝带非 bilibili Origin 的请求）。
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:9983'

export default defineConfig({
  // 相对基路径：当前部署在自定义域名根路径（evrc.tbpdt.top）下两种写法都可用，
  // 但用 './' 可以避免将来改挂子路径（如 user.github.io/eVRCalc/）时资源 404。
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    // .tsx 也要收：WeeklyRank.test.tsx 用 renderToStaticMarkup 验证
    // 「填入」按钮的渲染位置
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    // 本机沙箱禁止通过命名管道派生进程（spawn EPERM），
    // 默认的 forks 池无法启动，因此改用单线程、不隔离的线程池。
    pool: 'threads',
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
