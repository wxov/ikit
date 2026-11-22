// 「小知」模型清单 API（2026-11-22）
// - GET  /api/llm/models：登录即可；站主拿全部，其他用户只拿「对普通用户可见」的模型
// - PUT  /api/llm/models：仅站主，保存整份清单（含默认模型）
// 注意：服务端响应永不含明文 apiKey，只返回 hasKey + keyMask 掩码。
import { api } from './api'
import { authHeaders } from './auth'

export interface LlmModelPublic {
  id: string
  name: string
  model: string
  apiBase?: string
  visibleToUsers: boolean
  order: number
  /** 是否已配置独立密钥（未配置则回落到服务端 .env 的 LLM_API_KEY） */
  hasKey: boolean
  /** 密钥掩码，如 `sk-****abcd`；无密钥为空串 */
  keyMask: string
}

export interface LlmModelsPayload {
  models: LlmModelPublic[]
  defaultId: string
}

/** 保存时的模型条目：apiKey 留空/不传 = 保留原值；null = 清除 */
export interface LlmModelInput {
  id: string
  name: string
  model: string
  apiBase?: string
  apiKey?: string | null
  visibleToUsers?: boolean
  order?: number
}

export function listModels(): Promise<LlmModelsPayload> {
  return api<LlmModelsPayload>('/api/llm/models', { headers: authHeaders() })
}

export function saveModels(payload: {
  models: LlmModelInput[]
  defaultId: string
}): Promise<LlmModelsPayload> {
  return api<LlmModelsPayload>('/api/llm/models', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
}
