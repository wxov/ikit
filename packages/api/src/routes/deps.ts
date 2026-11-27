// 路由模块共享依赖（P2-10）：由 routes.ts 注入，保持行为不变
import type { AuditEvent } from '@ikit/shared'
import type { EntryVisibility, Viewer } from '@ikit/core'

 
export interface ApiRouteDeps {
  /** 要求已登录：解析用户后执行 fn；未登录 401 */
  requireUser: (req: any, reply: any, fn: (user: any) => Promise<any>) => any
  /** 要求站主：非 admin 403 */
  requireAdmin: (req: any, reply: any, fn: () => Promise<any>) => any
  /** 从 Authorization 头取 token */
  tokenOf: (req: any) => string
  /** 写操作审计（未配置时为空操作） */
  audit: (event: AuditEvent) => void
  /** 客户端 IP */
  ipOf: (req: any) => string
  /** 解析操作者用户名 */
  actorOf: (req: any) => Promise<string | undefined>
  /** 由用户对象解析可见性上下文（组集合 + 是否站主） */
  viewerOf: (user: any) => Promise<Viewer>
  /** 由请求（Authorization）解析可见性上下文 */
  resolveViewer: (req: any) => Promise<Viewer>
  /** 校验批量 ids（空/超限/非字符串 → 400 并返回 null） */
  parseBatchIds: (reply: any, ids: unknown) => string[] | null
  /** 可见性入参归一化（非法值返回 null） */
  normalizeVisibility: (v: string | undefined) => EntryVisibility | null
  /** 由用户对象构造 Agent 调用上下文 */
  callOf: (user: any) => Promise<{ viewer: Viewer; userId?: string; role: 'user' | 'admin' }>
  /** 解析本次请求使用的模型（不可用 → ok:false + error） */
  resolveAgentModel: (user: any, requested?: string) => any
}

