import { apiUrl, wsUrl } from './config'

export interface EntryVersion {
  version: number
  title: string
  content: string
  updatedAt: string
}

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  category?: string
  parentId?: string
  sortOrder?: number
  pinned?: boolean
  status?: 'draft' | 'published' | 'archived'
  history?: EntryVersion[]
  summary?: string
  rating?: number
  likes?: number
  shareToken?: string
  createdAt: string
  updatedAt: string
}

export interface CategoryNode {
  name: string
  path: string
  count: number
  children: CategoryNode[]
}

export interface WsMessage {
  type: string
  payload?: any
  ts?: number
}

export type EventItem = WsMessage

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export type WsStatus = 'connecting' | 'open' | 'closed'

export function createSocket(
  onMessage: (msg: WsMessage) => void,
  onStatus: (status: WsStatus) => void,
) {
  const url = wsUrl('/ws')
  let ws: WebSocket | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    onStatus('connecting')
    ws = new WebSocket(url)
    ws.onopen = () => onStatus('open')
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = () => {
      if (stopped) return
      onStatus('closed')
      timer = setTimeout(connect, 2000)
    }
    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    close() {
      stopped = true
      if (timer) clearTimeout(timer)
      ws?.close()
    },
  }
}
