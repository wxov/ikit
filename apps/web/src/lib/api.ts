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
  /** 软删除标记（回收站）：后端 KnowledgeEntry 已有该字段，前端此前漏声明 */
  deletedAt?: string
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

/** API 错误：`message` 为响应原文（保持既有行为），另附 HTTP `status` 供重试策略判断 4xx/5xx */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * 把 `api()` 抛出的错误转成用户可读文案：响应体为 `{ error: '...' }` 时取其 `error`（服务端明确错误，
 * 如「不能移动到自身或其子文档下」），否则原样返回。
 */
export function apiErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  try {
    const j = JSON.parse(raw) as { error?: string }
    if (j?.error) return j.error
  } catch {
    /* 非 JSON：原样展示 */
  }
  return raw
}

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
    throw new ApiError(text || `HTTP ${res.status}`, res.status)
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
