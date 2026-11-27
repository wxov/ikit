// 鉴权 / 可见性 / Agent 调用上下文等共享 helper（P2-10，2026-11-28）
//
// 这些 helper 原本内联在 routes.ts 顶部，被 account / knowledge / agent 等多个域共用。
// 抽成工厂后：routes.ts 与各子模块都通过 createAuthHelpers(ctx) 获得**同一份**实现，
// 避免拆分后各模块复制导致行为漂移。
import type { EntryVisibility, Viewer } from '@ikit/core'

 
const MAX_BATCH_IDS = 500

export interface AgentCall {
  viewer: Viewer
  userId?: string
  role: 'user' | 'admin'
}

export interface AuthHelpers {
  tokenOf(req: any): string
  requireAdmin<T>(req: any, reply: any, fn: () => Promise<T>): Promise<T | unknown>
  requireUser<T>(req: any, reply: any, fn: (user: any) => Promise<T>): Promise<T | unknown>
  viewerOf(user: any): Promise<Viewer>
  resolveViewer(req: any): Promise<Viewer>
  callOf(user: any): Promise<AgentCall>
  resolveAgentModel(
    user: any,
    requested?: string,
  ): { ok: true; rec: { id: string; model: string; apiBase?: string; apiKey?: string } } | { ok: false; error: string }
  normalizeVisibility(v: string | undefined): EntryVisibility | null
  parseBatchIds(reply: any, ids: unknown): string[] | null
}

export function createAuthHelpers(ctx: any): AuthHelpers {
  const tokenOf = (req: any) =>
    ((req.headers['authorization'] as string) || '').replace(/^Bearer\s+/i, '').trim()

  function requireAdmin<T>(req: any, reply: any, fn: () => Promise<T>) {
    return (async () => {
      const token = tokenOf(req)
      const user = await ctx.account.me(token)
      if (!user || user.role !== 'admin') {
        return reply.code(403).send({ error: '需要站主权限' })
      }
      return await fn()
    })()
  }

  // 要求已登录（游客只读，写操作需登录）
  function requireUser<T>(req: any, reply: any, fn: (user: any) => Promise<T>) {
    return (async () => {
      const user = await ctx.account.me(tokenOf(req))
      if (!user) {
        return reply.code(401).send({ error: '请先登录' })
      }
      return await fn(user)
    })()
  }

  // 由用户对象解析「可见性判定上下文」（组集合含包含关系展开 + 是否站主）
  async function viewerOf(user: any): Promise<Viewer> {
    const groups = await ctx.account.effectiveGroupsOf(user)
    return { groups, isAdmin: user?.role === 'admin' }
  }

  async function resolveViewer(req: any): Promise<Viewer> {
    return viewerOf(await ctx.account.me(tokenOf(req)))
  }

  // user → Agent 调用上下文（完善④）：viewer 由「调用者」解析，与 HTTP 知识库接口同源
  async function callOf(user: any): Promise<AgentCall> {
    return {
      viewer: await viewerOf(user),
      userId: user?.id as string | undefined,
      // 写类工具（knowledge_add/knowledge_update）据此鉴权：仅站主可用
      role: (user?.role === 'admin' ? 'admin' : 'user') as 'user' | 'admin',
    }
  }

  /**
   * 解析「小知」本次请求使用的模型（2026-11-22 模型配置与选择）：
   * - 未指定 → 默认模型；
   * - 指定 → 必须在「该角色可见的模型清单」内（非 admin 只能用 visibleToUsers 的），否则 400；
   * - 返回可直接透传给 llm 的 { model, apiBase?, apiKey? }。
   */
  function resolveAgentModel(
    user: any,
    requested?: string,
  ):
    | { ok: true; rec: { id: string; model: string; apiBase?: string; apiKey?: string } }
    | { ok: false; error: string } {
    const rid = (requested ?? '').trim()
    const view = ctx.llmModels.listPublic(user?.role)
    if (rid && !view.models.some((m: { id: string }) => m.id === rid)) {
      return { ok: false, error: '无权使用该模型或模型不存在' }
    }
    try {
      return { ok: true, rec: ctx.llmModels.resolve(rid || undefined) }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '模型配置不可用' }
    }
  }

  function normalizeVisibility(v: string | undefined): EntryVisibility | null {
    return v === 'public' || v === 'login' || v === 'groups' || v === 'private' ? v : null
  }

  /**
   * 批量接口 `ids` 入参校验（站主）：必须为非空字符串数组、元素非空、数量 ≤ MAX_BATCH_IDS。
   * 校验不通过时已发送 400 并返回 null，调用方直接 return（不进入服务层写入）。
   */
  function parseBatchIds(reply: any, ids: unknown): string[] | null {
    if (!Array.isArray(ids) || !ids.length) {
      reply.code(400).send({ error: 'ids array is required' })
      return null
    }
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
      reply.code(400).send({ error: 'ids must be non-empty strings' })
      return null
    }
    if (ids.length > MAX_BATCH_IDS) {
      reply.code(400).send({ error: `too many ids (max ${MAX_BATCH_IDS})` })
      return null
    }
    return ids as string[]
  }

  return { tokenOf, requireAdmin, requireUser, viewerOf, resolveViewer, callOf, resolveAgentModel, normalizeVisibility, parseBatchIds }
}
