// 小知模型清单的纯映射工具（P2-10 前端拆分，2026-11-28）
//
// 从 DocCuratorPanel.vue 抽出：模型复合键生成、供应商清单 → 编辑态行的转换。
// 纯函数、无 Vue / DOM 依赖，便于 node 单测。
import type { LlmProviderPublic } from './llm'

export interface ModelRow {
  key: string
  name: string
  model: string
  visibleToUsers: boolean
}
export interface ProviderRow {
  id: string
  name: string
  apiBase: string
  apiKey: string
  keyMask: string
  hasKey: boolean
  models: ModelRow[]
}

/** 模型复合键：`<providerId|new>/<modelKey|model>` */
export function compositeOf(p: ProviderRow, m: ModelRow): string {
  return `${p.id || 'new'}/${m.key || m.model}`
}

/** 后端供应商清单 → 编辑态行（密钥不回显，模型 id 去掉 provider 前缀） */
export function providersFrom(list: LlmProviderPublic[]): ProviderRow[] {
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    apiBase: p.apiBase,
    apiKey: '',
    keyMask: p.keyMask,
    hasKey: p.hasKey,
    models: p.models.map((m) => ({
      key: m.id.startsWith(p.id + '/') ? m.id.slice(p.id.length + 1) : m.id,
      name: m.name,
      model: m.model,
      visibleToUsers: m.visibleToUsers,
    })),
  }))
}
