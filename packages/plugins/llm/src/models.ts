// LLM 模型清单（「小知」的模型配置与选择）
//
// - 独立 JSON 持久化（默认 `<cwd>/data/llm-models.json`），写入走「临时文件 + rename」保证原子性；
// - **密钥安全**：对外视图（listPublic）永不含 apiKey 明文，只暴露 hasKey + 掩码（如 `sk-****abcd`）；
// - 首次启动用 llm Config（apiBase/apiKey/model，通常来自 .env）种子出一条默认记录，保证旧配置继续可用；
// - 权限：站主看全部；其他登录用户只看到 `visibleToUsers` 的记录。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LlmModelRecord {
  id: string
  /** 显示名（如「DeepSeek Chat」） */
  name: string
  /** 模型 id（请求体里的 model，如 deepseek-chat / gpt-4o-mini） */
  model: string
  /** 可选：覆盖默认 apiBase（OpenAI 兼容地址，不带 /chat/completions） */
  apiBase?: string
  /** 可选：该模型独立密钥；缺省则回落到 llm Config 的 apiKey（.env LLM_API_KEY） */
  apiKey?: string
  /** 是否允许普通登录用户选择 */
  visibleToUsers: boolean
  order: number
}

/** 对外（API 响应）视图：不含明文密钥 */
export interface LlmModelPublic {
  id: string
  name: string
  model: string
  apiBase?: string
  visibleToUsers: boolean
  order: number
  hasKey: boolean
  keyMask: string
}

export interface LlmModelsPayload {
  models: LlmModelPublic[]
  defaultId: string
}

export interface LlmModelInput {
  id: string
  name: string
  model: string
  apiBase?: string
  /** undefined / '' = 保留原值；null = 清除 */
  apiKey?: string | null
  visibleToUsers?: boolean
  order?: number
}

export interface LlmModelRegistry {
  /** 站主视图：全部模型（脱敏） */
  listAll(): LlmModelsPayload
  /** 使用视图：admin 全部，其他仅 visibleToUsers（脱敏） */
  listPublic(role?: string): LlmModelsPayload
  get(id: string): LlmModelRecord | undefined
  /** 解析某记录为调用参数；id 缺省 → 默认模型 */
  resolve(id?: string): { id: string; model: string; apiBase?: string; apiKey?: string }
  /** 保存整份清单（站主）；校验失败抛 Error（中文信息） */
  save(input: { models: LlmModelInput[]; defaultId: string }): LlmModelsPayload
}

const KEY_MASK_TAIL = 4

/** 密钥掩码：保留前缀（如 sk-）与末 4 位，其余打码；无 key 返回空串 */
export function maskKey(key?: string): string {
  const k = (key ?? '').trim()
  if (!k) return ''
  if (k.length <= KEY_MASK_TAIL) return '*'.repeat(k.length)
  const prefix = k.startsWith('sk-') ? 'sk-' : ''
  const head = prefix ? prefix : k.slice(0, Math.min(3, Math.max(0, k.length - KEY_MASK_TAIL - 4)))
  const tail = k.slice(-KEY_MASK_TAIL)
  return `${head}****${tail}`
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function toPublic(r: LlmModelRecord): LlmModelPublic {
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    apiBase: r.apiBase || undefined,
    visibleToUsers: !!r.visibleToUsers,
    order: r.order,
    hasKey: !!r.apiKey,
    keyMask: maskKey(r.apiKey),
  }
}

interface StoreFile {
  models: LlmModelRecord[]
  defaultId: string
}

export interface ModelRegistryOptions {
  /** 存储文件绝对路径 */
  file: string
  /** 首次种子（来自 llm Config / .env） */
  seed: { model: string; apiBase?: string; apiKey?: string }
}

export function createModelRegistry(opts: ModelRegistryOptions): LlmModelRegistry {
  const file = opts.file
  let data: StoreFile | null = null

  function ensureLoaded(): StoreFile {
    if (data) return data
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as StoreFile
        if (Array.isArray(raw?.models) && raw.models.length) {
          data = {
            models: raw.models.map((m, i) => ({
              id: String(m.id || `m${i + 1}`),
              name: String(m.name || m.model || `模型${i + 1}`),
              model: String(m.model || ''),
              apiBase: m.apiBase || undefined,
              apiKey: m.apiKey || undefined,
              visibleToUsers: m.visibleToUsers !== false,
              order: typeof m.order === 'number' ? m.order : i,
            })),
            defaultId: String(raw.defaultId || raw.models[0].id),
          }
          return data
        }
      }
    } catch (e) {
      console.warn('[llm] 模型清单损坏，将重新种子：', (e as Error)?.message)
    }
    // 首次种子：用当前 llm Config（通常来自 .env）生成默认模型，保证旧部署行为不变
    const seed: LlmModelRecord = {
      id: 'default',
      name: `默认（${opts.seed.model}）`,
      model: opts.seed.model,
      apiBase: opts.seed.apiBase || undefined,
      apiKey: opts.seed.apiKey || undefined,
      visibleToUsers: true,
      order: 0,
    }
    data = { models: [seed], defaultId: seed.id }
    persist(data)
    return data
  }

  function persist(next: StoreFile) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) {
      throw new Error(`模型清单写入失败：${(e as Error)?.message ?? e}`)
    }
  }

  function sorted(models: LlmModelRecord[]): LlmModelRecord[] {
    return [...models].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  return {
    listAll() {
      const d = ensureLoaded()
      return { models: sorted(d.models).map(toPublic), defaultId: d.defaultId }
    },

    listPublic(role?: string) {
      const d = ensureLoaded()
      const list = role === 'admin' ? d.models : d.models.filter((m) => m.visibleToUsers)
      const models = sorted(list).map(toPublic)
      // 默认模型对普通用户不可见时，回落到其第一个可见模型（避免前端无选择）
      const defaultVisible = models.some((m) => m.id === d.defaultId) ? d.defaultId : (models[0]?.id ?? '')
      return { models, defaultId: defaultVisible }
    },

    get(id) {
      return ensureLoaded().models.find((m) => m.id === id)
    },

    resolve(id) {
      const d = ensureLoaded()
      const rec = d.models.find((m) => m.id === id) ?? d.models.find((m) => m.id === d.defaultId) ?? d.models[0]
      if (!rec) throw new Error('未配置任何模型，请先在「设置 → 模型配置」中添加')
      return { id: rec.id, model: rec.model, apiBase: rec.apiBase, apiKey: rec.apiKey }
    },

    save(input) {
      const d = ensureLoaded()
      const incoming = Array.isArray(input?.models) ? input.models : []
      if (!incoming.length) throw new Error('至少需要配置一个模型')
      const ids = new Set<string>()
      const nextId = (raw: string, i: number) => {
        const base = (raw || '').trim() || `m${i + 1}`
        let id = base
        let n = 2
        while (ids.has(id)) id = `${base}-${n++}`
        ids.add(id)
        return id
      }
      const next: LlmModelRecord[] = incoming.map((m, i) => {
        const id = nextId(m.id ?? '', i)
        const name = String(m.name ?? '').trim()
        const model = String(m.model ?? '').trim()
        if (!name) throw new Error(`第 ${i + 1} 个模型的显示名不能为空`)
        if (!model) throw new Error(`第 ${i + 1} 个模型的模型 id 不能为空`)
        const apiBase = m.apiBase?.trim() || undefined
        if (apiBase && !isHttpUrl(apiBase)) throw new Error(`第 ${i + 1} 个模型的 apiBase 不是合法的 http(s) 地址`)
        const prev = d.models.find((x) => x.id === id)
        let apiKey: string | undefined
        if (m.apiKey === null) apiKey = undefined
        else if (typeof m.apiKey === 'string' && m.apiKey.trim()) apiKey = m.apiKey.trim()
        else apiKey = prev?.apiKey // 留空 = 保留原值
        return {
          id,
          name,
          model,
          apiBase,
          apiKey,
          visibleToUsers: m.visibleToUsers !== false,
          order: typeof m.order === 'number' ? m.order : i,
        }
      })
      const defaultId = (input.defaultId || '').trim()
      if (!defaultId || !next.some((m) => m.id === defaultId)) {
        throw new Error('默认模型必须是列表中的一个模型')
      }
      const store: StoreFile = { models: next, defaultId }
      persist(store)
      data = store
      return { models: sorted(next).map(toPublic), defaultId }
    },
  }
}
