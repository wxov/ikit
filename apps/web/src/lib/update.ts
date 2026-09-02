// 跨端更新检测、带进度下载与应用
import { apiUrl } from './config'

export type Platform = 'web' | 'tauri' | 'capacitor'

export interface UpdateInfo {
  currentVersion: string
  latest: string
  hasUpdate: boolean
  bundleUrl: string | null
  /** 硬更新安装包地址（有值 = 需下载安装包后安装） */
  installerUrl?: string | null
  buildTime: string | null
}

// 构建时注入的应用版本（vite define）
declare const __APP_VERSION__: string
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

// 检测当前运行平台
export function detectPlatform(): Platform {
  // Tauri 2：window.__TAURI_INTERNALS__
  const w = window as any
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return 'tauri'
  // Capacitor：window.Capacitor
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor'
  return 'web'
}

export async function fetchUpdateManifest(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(apiUrl(`/api/update/manifest?client=${APP_VERSION}`), { cache: 'no-store' })
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

/** 带进度下载：返回 Blob，实时回调百分比（0-100） */
export async function downloadWithProgress(
  url: string,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (!res.body) {
    const blob = await res.blob()
    onProgress?.(100)
    return blob
  }
  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value.slice())
      received += value.length
      if (total > 0) onProgress?.(Math.min(99, Math.round((received / total) * 100)))
    }
  }
  onProgress?.(100)
  return new Blob(chunks)
}

/** 从 URL 推断文件名 */
export function filenameFromUrl(url: string): string {
  const base = url.split('?')[0].split('/').pop() || ''
  return base || 'i-kit-update'
}

/** 触发浏览器保存 Blob 为文件 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export interface ApplyResult {
  applied: boolean
  platform: Platform
  url: string
  /** 是否硬更新（下载安装包而非热更新） */
  hardUpdate: boolean
  /** 硬更新下载得到的安装包 Blob */
  installerBlob?: Blob
}

// 应用更新
// - 硬更新：下载安装包（带进度）→ 由调用方提示安装
// - web：下载分发包（带进度）→ 刷新加载新资源
// - tauri：调用原生命令 apply_web_update（下载+解压+重启）
// - capacitor：调用 Capacitor 更新逻辑
export async function applyUpdate(
  info: UpdateInfo,
  onProgress?: (pct: number) => void,
): Promise<ApplyResult> {
  const platform = detectPlatform()

  // 硬更新：存在安装包地址时，下载安装包并交给调用方提示安装
  if (info.installerUrl) {
    const url = apiUrl(info.installerUrl)
    const blob = await downloadWithProgress(url, onProgress)
    return { applied: false, platform, url, hardUpdate: true, installerBlob: blob }
  }

  const url = apiUrl(info.bundleUrl ?? '')
  if (platform === 'web') {
    // 服务端已部署新 dist：下载分发包仅用于展示实时进度，完成后刷新即热更新
    if (url) await downloadWithProgress(url, onProgress)
    else onProgress?.(100)
    location.reload()
    return { applied: true, platform, url, hardUpdate: false }
  }

  if (platform === 'tauri') {
    const w = window as any
    if (w.__TAURI_INTERNALS__?.invoke) {
      onProgress?.(10)
      try {
        await w.__TAURI_INTERNALS__.invoke('apply_web_update', { url })
        onProgress?.(100)
        // 热更新：切到自定义 webupdate:// 协议重新加载新资源
        window.location.href = 'webupdate://localhost/index.html'
        return { applied: true, platform, url, hardUpdate: false }
      } catch {
        onProgress?.(100)
        return { applied: false, platform, url, hardUpdate: false }
      }
    }
    return { applied: false, platform, url, hardUpdate: false }
  }

  const w2 = window as any
  if (w2.Capacitor?.Plugins?.WebUpdate) {
    onProgress?.(10)
    await w2.Capacitor.Plugins.WebUpdate.applyUpdate({ url })
    onProgress?.(100)
    return { applied: true, platform, url, hardUpdate: false }
  }
  return { applied: false, platform, url, hardUpdate: false }
}
