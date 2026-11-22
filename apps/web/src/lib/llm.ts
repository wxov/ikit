// 「小知」模型清单 API（v2：按供应商分组，2026-11-22）
// - GET  /api/llm/models：登录即可；站主拿全部，其他用户只拿「对普通用户可见」的模型
// - PUT  /api/llm/models：仅站主，保存整份清单（供应商分组 + 默认模型）
// - POST /api/llm/models/fetch：仅站主，服务端代理 GET {apiBase}/models 拉取模型列表
// 注意：服务端响应永不含明文 apiKey，只返回 hasKey + keyMask 掩码。
import { api } from './api'
import { authHeaders } from './auth'

export interface LlmModelPublic {
  /** 全局 id：`${providerId}/${modelKey}` */
  id: string
  providerId: string
  providerName: string
  name: string
  model: string
  apiBase: string
  visibleToUsers: boolean
  /** 该供应商是否已配置密钥（未配置则回落到 .env 的 LLM_API_KEY） */
  hasKey: boolean
  keyMask: string
  order: number
}

export interface LlmProviderPublic {
  id: string
  name: string
  apiBase: string
  hasKey: boolean
  keyMask: string
  order: number
  models: LlmModelPublic[]
}

export interface LlmModelsPayload {
  providers: LlmProviderPublic[]
  models: LlmModelPublic[]
  defaultId: string
}

export interface LlmModelInput {
  key?: string
  name?: string
  model: string
  visibleToUsers?: boolean
}

export interface LlmProviderInput {
  id?: string
  name?: string
  apiBase: string
  /** undefined / '' = 保留原值；null = 清除 */
  apiKey?: string | null
  models: LlmModelInput[]
  order?: number
}

export function listModels(): Promise<LlmModelsPayload> {
  return api<LlmModelsPayload>('/api/llm/models', { headers: authHeaders() })
}

export function saveModels(payload: {
  providers: LlmProviderInput[]
  defaultKey: string
}): Promise<LlmModelsPayload> {
  return api<LlmModelsPayload>('/api/llm/models', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
}

/** 一键获取模型列表（站主）：apiKey 留空时用 providerId 已保存的密钥 */
export function fetchModelList(payload: {
  apiBase: string
  apiKey?: string
  providerId?: string
}): Promise<{ models: Array<{ id: string; name: string; ownedBy?: string }> }> {
  return api<{ models: Array<{ id: string; name: string; ownedBy?: string }> }>(
    '/api/llm/models/fetch',
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) },
  )
}
