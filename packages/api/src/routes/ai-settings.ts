// AI 设置（仅站主，2026-11-28，M3）
import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ApiRouteDeps } from './deps.js'
import { DEFAULT_AI_SETTINGS, loadAiSettings, saveAiSettings } from '../ai-settings.js'

export function registerAiSettingsRoutes(app: FastifyInstance, _ctx: Context, deps: ApiRouteDeps): void {
  const { requireAdmin, audit, ipOf, actorOf } = deps

  app.get('/api/ai/settings', (req, reply) =>
    requireAdmin(req, reply, async () => ({
      settings: loadAiSettings(),
      defaults: DEFAULT_AI_SETTINGS,
    })),
  )

  app.put(
    '/api/ai/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            promptPolish: { type: 'boolean' },
            skillVariant: { type: 'string', enum: ['off', 'a', 'b', 'auto'] },
            summaryThreshold: { type: 'integer', minimum: 4, maximum: 100 },
            summaryKeep: { type: 'integer', minimum: 2, maximum: 40 },
            polishIntensity: { type: 'string', enum: ['light', 'standard', 'deep'] },
            polishStyle: { type: 'string', enum: ['plain', 'literary'] },
            dualVariantsDefault: { type: 'integer', enum: [1, 2] },
          },
        },
      },
    },
    (req, reply) =>
      requireAdmin(req, reply, async () => {
        const body = (req.body ?? {}) as Record<string, unknown>
        const saved = saveAiSettings(body)
        audit({
          action: 'ai.settings.update',
          ok: true,
          user: await actorOf(req),
          ip: ipOf(req),
          detail: { keys: Object.keys(body) },
        })
        return { settings: saved }
      }),
  )
}
