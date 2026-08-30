// 跨端热更新检测与下载
import { apiUrl } from './config'

export type Platform = 'web' | 'tauri' | 'capacitor'

export interface UpdateInfo {
  currentVersion: string
  latest: string
  hasUpdate: boolean
  bundleUrl: string | null
  buildTime: string | null
}

// 检测当前运行平台
export function detectPlatform(): Platform {
  // Tauri 2：window.__TAURI_INTERNALS__
  const w = window as any
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return 'tauri'
  // Capacitor：window.Capacitor
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor'
  return 'web'
}

// 当前 web 版本（构建时注入）
export const CURRENT_WEB_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.1.2'

export async function fetchUpdateManifest(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(apiUrl('/api/update/manifest'), { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as UpdateInfo
  } catch {
    return null
  }
}

// 判断是否有可用更新（latest != current）
export function hasUpdate(info: UpdateInfo | null): boolean {
  if (!info) return false
  return info.hasUpdate && info.latest !== info.currentVersion
}

// 下载更新包（统一入口）
export async function downloadBundle(url: string): Promise<Blob> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  return res.blob()
}

// 各平台应用更新
// - web: 刷新页面（服务端已部署新 dist），热更新无需重装
// - tauri: 调用原生命令 apply_web_update（下载+解压+重启）
// - capacitor: 调用 Capacitor Python 更新逻辑
export async function applyUpdate(
  info: UpdateInfo,
  bundleUrl: string,
): Promise<{ applied: boolean; platform: Platform; url: string }> {
  const platform = detectPlatform()
  const url = apiUrl(bundleUrl)
  if (platform === 'web') {
    // 服务端已部署新 dist，刷新即热更新
    location.reload()
    return { applied: true, platform, url }
  }
  if (platform === 'tauri') {
    const w = window as any
    if (w.__TAURI_INTERNALS__?.invoke) {
      try {
        await w.__TAURI_INTERNALS__.invoke('apply_web_update', { url })
        // 热更新：切到自定义 webupdate:// 协议重新加载新资源
        window.location.href = 'webupdate://localhost/index.html'
        return { applied: true, platform, url }
      } catch {
        // 未注册原生命令 → 交给调用方提示下载
        return { applied: false, platform, url }
      }
    }
    return { applied: false, platform, url }
  }
  const w = window as any
  if (w.Capacitor?.Plugins?.WebUpdate) {
    await w.Capacitor.Plugins.WebUpdate.applyUpdate({ url })
    // 插件内部已 hostFiles + reload
    return { applied: true, platform, url }
  }
  return { applied: false, platform, url }
}

// 简短版本比较
export function versionGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}
