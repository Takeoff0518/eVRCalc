/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * API 基地址（Go 后端的地址）。
   *
   * 生产构建必填：前端在 GitHub Pages，后端跑在家里那台机器上，两者跨域。
   * 例：VITE_API_BASE=https://mc.tbpdt.top:9983
   *
   * 留空则走相对路径（本地开发由 Vite proxy 转发，同源）。
   */
  readonly VITE_API_BASE?: string

  /**
   * B 站接口基地址。**默认跟随 VITE_API_BASE** —— 目前周刊与 B 站由同一个
   * Go 后端提供，所以通常不用填。
   *
   * 单独留出来的原因：B 站接口必须从住宅 IP 出（B 站 WAF 会拦机房 IP），
   * 将来若把周刊挪回 CDN、只留 B 站那半边在本机，改这一个变量即可，不用动代码。
   */
  readonly VITE_BILI_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
