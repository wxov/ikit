// 由 routes.ts 拆分（P2-10，2026-11-28）
import type { FastifyInstance } from 'fastify'
import type { ApiRouteDeps } from './deps.js'

export function registerAccountRoutes(app: FastifyInstance, ctx: any, deps: ApiRouteDeps): void {
  const { requireUser, requireAdmin, tokenOf, audit, ipOf, actorOf, viewerOf, resolveViewer, callOf, resolveAgentModel, normalizeVisibility, parseBatchIds } = deps

  // 注册已屏蔽（站主在用户管理手动建号）；保留登录/找回
  // 登录：账号维度限流在 account 服务内（5 次失败锁 5 分钟）；此处再按 IP 维度限流（20 次失败锁 10 分钟）
  const loginIpFails = new Map<string, { fails: number; lockedUntil: number }>()
  const LOGIN_IP_MAX = 20
  const LOGIN_IP_LOCK_MS = 10 * 60_000
  app.post(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
    const ip = String((req as any).ip ?? 'unknown')
    const now = Date.now()
    const rec = loginIpFails.get(ip)
    if (rec && rec.lockedUntil > now) {
      const min = Math.max(1, Math.ceil((rec.lockedUntil - now) / 60_000))
      return reply.code(429).send({ error: `登录尝试过于频繁，请 ${min} 分钟后再试`, code: 'E_LOGIN_LOCKED' })
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    try {
      const r = await ctx.account.login(username ?? '', password ?? '')
      loginIpFails.delete(ip)
      audit({ action: 'auth.login', ok: true, user: r.user.username, ip })
      return { token: r.token, user: r.user }
    } catch (e: any) {
      const next = loginIpFails.get(ip) ?? { fails: 0, lockedUntil: 0 }
      next.fails += 1
      if (next.fails >= LOGIN_IP_MAX) {
        next.fails = 0
        next.lockedUntil = Date.now() + LOGIN_IP_LOCK_MS
      }
      loginIpFails.set(ip, next)
      audit({ action: 'auth.login', ok: false, user: username, ip, detail: { code: e?.code } })
      const status = e?.code === 'E_LOGIN_LOCKED' ? 429 : 401
      return reply.code(status).send({ error: e?.message ?? '登录失败', code: e?.code })
    }
  })

  app.post('/api/auth/request-reset', async (req) => {
    const { username } = (req.body ?? {}) as { username?: string }
    const r = await ctx.account.requestReset(username ?? '')
    // 已配置邮件：sent=true（不发纯文本令牌）；未配置则返回 resetToken 供演示/前端
    return { sent: r?.sent ?? false, resetToken: r?.resetToken ?? null }
  })

  app.post('/api/auth/reset-password', async (req, reply) => {
    const { resetToken, password } = (req.body ?? {}) as { resetToken?: string; password?: string }
    const ok = await ctx.account.resetPassword(resetToken ?? '', password ?? '')
    if (!ok) return reply.code(400).send({ error: '重置码无效或已过期' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    const user = await ctx.account.me(tokenOf(req))
    return { user }
  })

  app.post('/api/auth/logout', async (req) => {
    await ctx.account.logout(tokenOf(req))
    return { ok: true }
  })

  // ---- 用户自助修改资料（改用户名 / 改密码）----
  app.post('/api/auth/profile', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = req.body as { username?: string; oldPassword?: string; newPassword?: string }
      try {
        const updated = await ctx.account.updateProfile(user.id, {
          username: body?.username,
          oldPassword: body?.oldPassword,
          newPassword: body?.newPassword,
        })
        return { user: updated }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )

  // ---- 站主管理用户 ----
  app.get('/api/auth/users', (req, reply) => requireAdmin(req, reply, async () => ({ users: await ctx.account.listUsers() })))
  app.post('/api/auth/users', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { username?: string; password?: string; role?: 'user' | 'admin'; groupIds?: string[] }
      try {
        const user = await ctx.account.createUser(
          body?.username ?? '',
          body?.password ?? '',
          body?.role === 'admin' ? 'admin' : 'user',
          body?.groupIds,
        )
        audit({ action: 'user.create', ok: true, user: await actorOf(req), ip: ipOf(req), target: user.username })
        return reply.code(201).send({ user, users: await ctx.account.listUsers() })
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.post('/api/auth/users/:id/disable', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { disabled?: boolean }
      return { users: await ctx.account.disableUser(id, !!body?.disabled) }
    }),
  )
  app.delete('/api/auth/users/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const users = await ctx.account.deleteUser(id)
      audit({ action: 'user.delete', ok: true, user: await actorOf(req), ip: ipOf(req), target: id })
      return { users }
    }),
  )
  app.post('/api/auth/users/:id/role', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { role?: 'user' | 'admin' }
      return { users: await ctx.account.setRole(id, body?.role === 'admin' ? 'admin' : 'user') }
    }),
  )

  // 设置用户所属组（多组）
  app.post('/api/auth/users/:id/groups', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { groupIds?: string[] }
      try {
        return { users: await ctx.account.setUserGroups(id, body?.groupIds ?? []) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )

  // ---- 用户组管理（站主） ----
  app.get('/api/groups', (req, reply) =>
    requireAdmin(req, reply, async () => ({ groups: await ctx.account.listGroups() })),
  )
  app.post('/api/groups', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { name?: string; description?: string; parentId?: string }
      try {
        return { groups: await ctx.account.createGroup(body?.name ?? '', body?.description, body?.parentId) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.post('/api/groups/:id/parent', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { parentId?: string | null }
      try {
        return { groups: await ctx.account.setGroupParent(id, body?.parentId ?? undefined) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.patch('/api/groups/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { name?: string }
      try {
        return { groups: await ctx.account.renameGroup(id, body?.name ?? '') }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.delete('/api/groups/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      try {
        return { groups: await ctx.account.deleteGroup(id) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
}
