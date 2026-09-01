// 插件注册表前端类型 + API
import { api } from './api'
import { authHeaders } from './auth'

export type PluginRole = 'guest' | 'user' | 'admin'

export interface PluginVisibility {
  guest: boolean
  user: boolean
  admin: boolean
}

export interface PluginRecord {
  name: string
  title: string
  version: string
  enabled: boolean
  builtin: boolean
  order: number
  visibility: PluginVisibility
  panel?: string
}

export interface VisiblePlugins {
  role: PluginRole
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

export function setPluginVisibility(
  name: string,
  role: PluginRole,
  visible: boolean,
): Promise<{ plugins: PluginRecord[] }> {
  return api(`/api/plugins/${name}/visibility`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ role, visible }),
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
}

export function fetchPluginStore(): Promise<{ store: PluginStoreItem[] }> {
  return api<{ store: PluginStoreItem[] }>('/api/plugin-store', { headers: authHeaders() })
}
export function fetchPluginCategories(): Promise<{ categories: string[] }> {
  return api<{ categories: string[] }>('/api/plugin-store/categories', { headers: authHeaders() })
}
export function installPlugin(name: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api('/api/plugin-store/install', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name }) })
}
export function updatePlugin(name: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api(`/api/plugin-store/${name}/update`, { method: 'POST', headers: authHeaders() })
}
export function uninstallPlugin(name: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api(`/api/plugin-store/${name}`, { method: 'DELETE', headers: authHeaders() })
}
export function ratePlugin(name: string, score: number, comment: string): Promise<{ store: PluginStoreItem[] }> {
  return api('/api/plugin-store/rate', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, score, comment }),
  })
}
