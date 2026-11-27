// 路由模块共享依赖（P2-10）：由 routes.ts 注入，保持行为不变
import type { AuditEvent } from '@ikit/shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
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
}
