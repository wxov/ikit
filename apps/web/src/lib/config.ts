// API 基地址配置（三端复用的关键）
// - Web 端：默认空字符串 → 相对路径（dev 走 Vite proxy，生产同源部署）
// - 桌面端（Tauri）/ 移动端（Capacitor）：构建时通过 VITE_API_BASE 注入后端绝对地址
//   例如：VITE_API_BASE=http://192.168.1.100:3000
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

export function apiUrl(path: string): string {
  return API_BASE + path
}

export function wsUrl(path: string): string {
  if (API_BASE) {
    return API_BASE.replace(/^http/, 'ws') + path
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}
