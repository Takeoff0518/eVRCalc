/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * API 基地址（Cloudflare Worker）。
   *
   * 生产构建必填：前端在 GitHub Pages，API 在 Cloudflare 子域，两者跨域。
   * 例：VITE_API_BASE=https://api.tbpdt.top
   *
   * 留空则走相对路径（本地开发由 Vite proxy 转发，同源）。
   */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
