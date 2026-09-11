/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 本地开发时，/api 走 dev proxy 打到 wrangler dev（127.0.0.1:8787）。
// 浏览器只看到同源请求，因此本地也能跑通联网功能。
// changeOrigin 会把 Host 改掉，浏览器发出的 Origin 不会传到 Worker，
// 于是 Worker 出网请求不带 Origin —— 正是绕开 B 站 WAF 的关键。
//
// 若你已部署 Worker，也可以把 target 直接指向线上域名，无需本地 worker。
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787'

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
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // 本机沙箱禁止通过命名管道派生进程（spawn EPERM），
    // 默认的 forks 池无法启动，因此改用单线程、不隔离的线程池。
    pool: 'threads',
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
