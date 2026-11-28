// 管理端 AI 设置（2026-11-28，M3）：前端类型与请求封装
import { api } from './api'
import { authHeaders } from './auth'

export type SkillVariantMode = 'off' | 'a' | 'b' | 'auto'
export type PolishIntensity = 'light' | 'standard' | 'deep'
export type PolishStyle = 'plain' | 'literary'

export interface AiSettings {
  promptPolish: boolean
  skillVariant: SkillVariantMode
  summaryThreshold: number
  summaryKeep: number
  polishIntensity: PolishIntensity
  polishStyle: PolishStyle
  dualVariantsDefault: 1 | 2
}

export async function fetchAiSettings(): Promise<{ settings: AiSettings; defaults: AiSettings }> {
  return api('/api/ai/settings', { headers: authHeaders() })
}

export async function updateAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const r = await api<{ settings: AiSettings }>('/api/ai/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  return r.settings
}
