// 插件注册表前端类型 + API
import { api } from './api'
import { apiUrl } from './config'
import { authHeaders } from './auth'

export type PluginRole = 'guest' | 'user' | 'admin'

export interface PluginRecord {
  name: string
  title: string
  version: string
  enabled: boolean
  builtin: boolean
  order: number
  visibleGroups: string[]
  panel?: string
}

export interface VisiblePlugins {
  role: PluginRole
  groups?: string[]
  plugins: PluginRecord[]
}

export function fetchAllPlugins(): Promise<{ plugins: PluginRecord[] }> {
  return api<{ plugins: PluginRecord[] }>('/api/plugins', { headers: authHeaders() })
}

export function setPluginEnabled(name: string, enabled: boolean): Promise<{ plugins: PluginRecord[] }> {
  return api(`/api/plugins/${name}/enable`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ enabled }),
  })
}

export function setPluginOrder(ordered: string[]): Promise<{ plugins: PluginRecord[] }> {
  return api('/api/plugins/order', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ordered }),
  })
}

export function setPluginGroups(name: string, groups: string[]): Promise<{ plugins: PluginRecord[] }> {
  return api(`/api/plugins/${name}/visibility`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ groups }),
  })
}

// ---- 插件商店 ----
export interface PluginReview {
  id: string
  author: string
  score: number
  comment: string
  createdAt: string
}
export interface PluginStoreItem {
  name: string
  title: string
  description: string
  version: string
  author: string
  installed?: boolean
  installedVersion?: string
  category?: string
  rating?: number
  ratingCount?: number
  reviews?: PluginReview[]
  screenshots?: string[]
  source?: 'catalog' | 'local' | 'remote'
  packageUrl?: string
  sha256?: string
  deps?: string[]
  minIkit?: string
  updateAvailable?: boolean
}

export function fetchPluginStore(): Promise<{ store: PluginStoreItem[] }> {
  return api<{ store: PluginStoreItem[] }>('/api/plugin-store', { headers: authHeaders() })
}
export function fetchPluginCategories(): Promise<{ categories: string[] }> {
  return api<{ categories: string[] }>('/api/plugin-store/categories', { headers: authHeaders() })
}
export function installPlugin(
  input: string | { name: string; packageUrl?: string; sha256?: string },
): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  const body = typeof input === 'string' ? { name: input } : input
  return api('/api/plugin-store/install', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
}
export function updatePlugin(name: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api(`/api/plugin-store/${name}/update`, { method: 'POST', headers: authHeaders() })
}
export function uninstallPlugin(name: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api(`/api/plugin-store/${name}`, { method: 'DELETE', headers: authHeaders() })
}
export function importPlugin(data: string, sha256?: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api('/api/plugin-store/import', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ data, sha256 }),
  })
}
export function ratePlugin(name: string, score: number, comment: string): Promise<{ store: PluginStoreItem[] }> {
  return api('/api/plugin-store/rate', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, score, comment }),
  })
}

// 导出：fetch 携带鉴权头拿到 zip Blob，再触发浏览器下载（<a href> 无法带 Authorization）
export async function downloadPlugin(name: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/plugin-store/${name}/export`), { headers: authHeaders() })
  if (!res.ok) {
    let msg = `导出失败 (HTTP ${res.status})`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
