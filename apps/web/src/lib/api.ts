import { apiUrl, wsUrl } from './config'

export type EntryVisibility = 'public' | 'login' | 'groups' | 'private'

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
  views?: number
  cover?: string
  visibility?: EntryVisibility
  visibleGroups?: string[]
  createdAt: string
  updatedAt: string
}

export interface CategoryNode {
  name: string
  path: string
  count: number
  children: CategoryNode[]
}

export interface KnowledgeComment {
  id: string
  entryId: string
  author: string
  content: string
  parentId?: string
  likes?: number
  createdAt: string
}

export interface WsMessage {
  type: string
  payload?: any
  ts?: number
}

export type EventItem = WsMessage

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      // 仅在有 body 时才带 Content-Type，避免空 body 请求被 Fastify 拒绝
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options?.headers ?? {}),
    },
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
