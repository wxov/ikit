// 账号体系前端 API
import { api } from './api'

export interface PublicUser {
  id: string
  username: string
  role: 'user' | 'admin'
  groupIds?: string[]
  disabled: boolean
  createdAt: string
}

export interface Group {
  id: string
  name: string
  builtin: boolean
  description?: string
  parentId?: string
  createdAt: string
}

const TOKEN_KEY = 'ikit-token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

export function authHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export function login(username: string, password: string): Promise<{ token: string; user: PublicUser }> {
  return api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function requestReset(username: string): Promise<{ sent: boolean; resetToken: string | null }> {
  return api('/api/auth/request-reset', { method: 'POST', body: JSON.stringify({ username }) })
}

export function resetPassword(resetToken: string, password: string): Promise<{ ok: boolean }> {
  return api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ resetToken, password }) })
}

export async function currentUser(): Promise<PublicUser | null> {
  const t = getToken()
  if (!t) return null
  const r = await api<{ user: PublicUser | null }>('/api/auth/me', { headers: authHeaders() })
  return r.user
}

export function logout(): Promise<{ ok: boolean }> {
  return api('/api/auth/logout', { method: 'POST', headers: authHeaders() })
}

// ---- 站主管理用户 ----
export function listUsers(): Promise<{ users: PublicUser[] }> {
  return api('/api/auth/users', { headers: authHeaders() })
}
export function createUser(username: string, password: string, role: 'user' | 'admin' = 'user'): Promise<{ user: PublicUser; users: PublicUser[] }> {
  return api('/api/auth/users', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ username, password, role }) })
}
export function disableUser(id: string, disabled: boolean): Promise<{ users: PublicUser[] }> {
  return api(`/api/auth/users/${id}/disable`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ disabled }) })
}
export function deleteUser(id: string): Promise<{ users: PublicUser[] }> {
  return api(`/api/auth/users/${id}`, { method: 'DELETE', headers: authHeaders() })
}
export function setUserRole(id: string, role: 'user' | 'admin'): Promise<{ users: PublicUser[] }> {
  return api(`/api/auth/users/${id}/role`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ role }) })
}

export function setUserGroups(id: string, groupIds: string[]): Promise<{ users: PublicUser[] }> {
  return api(`/api/auth/users/${id}/groups`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ groupIds }) })
}

// ---- 用户组管理 ----
export function listGroups(): Promise<{ groups: Group[] }> {
  return api('/api/groups', { headers: authHeaders() })
}
export function createGroup(name: string, description?: string, parentId?: string): Promise<{ groups: Group[] }> {
  return api('/api/groups', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name, description, parentId }) })
}
export function renameGroup(id: string, name: string): Promise<{ groups: Group[] }> {
  return api(`/api/groups/${id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name }) })
}
export function deleteGroup(id: string): Promise<{ groups: Group[] }> {
  return api(`/api/groups/${id}`, { method: 'DELETE', headers: authHeaders() })
}
export function setGroupParent(id: string, parentId: string | null): Promise<{ groups: Group[] }> {
  return api(`/api/groups/${id}/parent`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ parentId }) })
}
