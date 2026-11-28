// 由 routes.ts 拆分（P2-10，2026-11-28）
import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ApiRouteDeps } from './deps.js'
import {
  buildPolishPrompt,
  nextIntensity,
  normalizePolishIntensity,
  normalizePolishStyle,
  normalizePolishType,
} from './shiguang-polish.js'

export function registerShiguangRoutes(app: FastifyInstance, ctx: Context, deps: ApiRouteDeps): void {
  const { requireAdmin, requireUser, audit, ipOf, actorOf } = deps

  // ---- 拾光（日记 / 感悟 / 名言，开门密码保护）----
  const shiguangTokenOf = (req: any) => String(req.headers?.['x-shiguang-token'] ?? '')
  /** 校验解锁令牌；不通过时直接回 401 并返回 false（调用方 return 即可） */
  function requireUnlock(req: any, reply: any): boolean {
    if (ctx.shiguang.verify(shiguangTokenOf(req))) return true
    reply.code(401).send({ error: '需要先解锁拾光', code: 'E_LOCKED' })
    return false
  }

  app.get('/api/shiguang/status', (req, reply) =>
    requireUser(req, reply, async () => ctx.shiguang.status()),
  )

  app.put(
    '/api/shiguang/passcode',
    {
      schema: {
        body: {
          type: 'object',
          required: ['newPasscode'],
          properties: {
            newPasscode: { type: 'string', minLength: 4, maxLength: 32 },
            oldPasscode: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = (req.body ?? {}) as { oldPasscode?: string; newPasscode?: string }
      try {
        await ctx.shiguang.setPasscode({ oldPasscode: body.oldPasscode, newPasscode: String(body.newPasscode ?? '') })
        audit({ action: 'shiguang.passcode.set', ok: true, user: user.username, ip: ipOf(req) })
        return { ok: true }
      } catch (e: any) {
        audit({ action: 'shiguang.passcode.set', ok: false, user: user.username, ip: ipOf(req), detail: { code: e?.code } })
        reply.code(400)
        return { error: e?.message ?? '设置失败', code: e?.code }
      }
    }),
  )

  // 忘记密码：站主可重置（清除密码，内容保留；用于把自己锁在外面的恢复路径）
  app.post('/api/shiguang/passcode/reset', (req, reply) =>
    requireAdmin(req, reply, async () => {
      await ctx.shiguang.resetPasscode()
      audit({ action: 'shiguang.passcode.reset', ok: true, user: await actorOf(req), ip: ipOf(req) })
      return { ok: true }
    }),
  )

  app.post(
    '/api/shiguang/unlock',
    {
      schema: {
        body: {
          type: 'object',
          required: ['passcode'],
          properties: { passcode: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    (req, reply) =>
    requireUser(req, reply, async () => {
      const { passcode } = (req.body ?? {}) as { passcode?: string }
      try {
        return await ctx.shiguang.unlock(String(passcode ?? ''))
      } catch (e: any) {
        reply.code(e?.code === 'E_LOCKED_OUT' ? 429 : 401)
        return { error: e?.message ?? '解锁失败', code: e?.code }
      }
    }),
  )

  app.post('/api/shiguang/lock', (req, reply) =>
    requireUser(req, reply, async () => {
      ctx.shiguang.lock(shiguangTokenOf(req))
      return { ok: true }
    }),
  )

  app.get('/api/shiguang/entries', (req, reply) =>
    requireUser(req, reply, async () => {
      if (!requireUnlock(req, reply)) return
      const type = (req.query as { type?: string })?.type
      return { entries: await ctx.shiguang.list(type as any) }
    }),
  )

  const shiguangEntrySchema = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['diary', 'insight', 'quote'] },
      content: { type: 'string', minLength: 1, maxLength: 20000 },
      date: { type: 'string', maxLength: 10 },
      title: { type: 'string', maxLength: 200 },
      author: { type: 'string', maxLength: 100 },
      tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 30 } },
    },
  } as const

  app.post(
    '/api/shiguang/entries',
    { schema: { body: { ...shiguangEntrySchema, required: ['type', 'content'] } } },
    (req, reply) =>
    requireUser(req, reply, async () => {
      if (!requireUnlock(req, reply)) return
      const body = (req.body ?? {}) as Record<string, unknown>
      try {
        return { entry: await ctx.shiguang.add(body as any) }
      } catch (e: any) {
        reply.code(400)
        return { error: e?.message ?? '保存失败', code: e?.code }
      }
    }),
  )

  app.patch(
    '/api/shiguang/entries/:id',
    { schema: { body: shiguangEntrySchema } },
    (req, reply) =>
    requireUser(req, reply, async () => {
      if (!requireUnlock(req, reply)) return
      const id = (req.params as { id: string }).id
      const body = (req.body ?? {}) as Record<string, unknown>
      try {
        return { entry: await ctx.shiguang.update(id, body as any) }
      } catch (e: any) {
        reply.code(e?.code === 'E_NOT_FOUND' ? 404 : 400)
        return { error: e?.message ?? '更新失败', code: e?.code }
      }
    }),
  )

  app.delete('/api/shiguang/entries/:id', (req, reply) =>
    requireUser(req, reply, async () => {
      if (!requireUnlock(req, reply)) return
      const id = (req.params as { id: string }).id
      try {
        await ctx.shiguang.remove(id)
        return { ok: true }
      } catch (e: any) {
        reply.code(e?.code === 'E_NOT_FOUND' ? 404 : 400)
        return { error: e?.message ?? '删除失败', code: e?.code }
      }
    }),
  )

  // ---- 拾光：AI 润色（仅日记 / 感悟；支持整篇 / 段落级、单版 / 双版，2026-11-28 M2）----
  app.post('/api/shiguang/polish', (req, reply) =>
    requireUser(req, reply, async () => {
      if (!requireUnlock(req, reply)) return
      const body = (req.body ?? {}) as {
        type?: string
        content?: string
        intensity?: string
        style?: string
        variants?: number
        section?: { before?: string; after?: string } | null
      }
      const type = normalizePolishType(body.type)
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (!type) {
        reply.code(400)
        return { error: '仅日记与感悟支持 AI 润色' }
      }
      if (!content) {
        reply.code(400)
        return { error: '内容不能为空' }
      }
      if (content.length > 4000) {
        reply.code(400)
        return { error: '内容过长（最多 4000 字）' }
      }
      const intensity = normalizePolishIntensity(body.intensity)
      const style = normalizePolishStyle(body.style)
      const variants: 1 | 2 = body.variants === 2 ? 2 : 1
      const section = body.section && (body.section.before || body.section.after) ? body.section : null
      const mode = section ? 'section' : 'full'
      const kind = type === 'diary' ? '日记' : '感悟'
      const before = String(section?.before ?? '').slice(-400)
      const after = String(section?.after ?? '').slice(0, 400)

      const runOne = async (int: typeof intensity): Promise<string> => {
        const prompt = buildPolishPrompt(type, int, style, mode)
        const user =
          mode === 'section'
            ? `【类型】${kind}\n【上文（仅参考）】\n${before || '（无）'}\n【选中段（只润色这一段）】\n${content}\n【下文（仅参考）】\n${after || '（无）'}`
            : `【类型】${kind}\n【原文】\n${content}`
        const res = await ctx.llm.chat(
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: user },
          ],
          { temperature: prompt.temperature, maxTokens: prompt.maxTokens },
        )
        let text = String(res.message?.content ?? '').trim()
        // 去掉模型偶尔带上的代码块/引号包裹
        text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim()
        text = text.replace(/^["“']([\s\S]*)["”']$/, '$1').trim()
        return text
      }

      try {
        const targets = variants === 2 ? [intensity, nextIntensity(intensity)] : [intensity]
        const settled = await Promise.allSettled(targets.map((i) => runOne(i)))
        const texts = settled
          .map((r) => (r.status === 'fulfilled' ? r.value : ''))
          .filter((t) => !!t)
        if (!texts.length) {
          reply.code(502)
          return { error: '润色结果为空，请重试' }
        }
        return {
          text: texts[0],
          alternatives: texts.slice(1),
          variants: texts.length,
          mode,
          intensity,
          style,
        }
      } catch (e: any) {
        reply.code(502)
        return { error: e?.message ?? 'AI 润色失败', code: 'E_POLISH_FAILED' }
      }
    }),
  )
}
