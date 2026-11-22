// LLM 模型清单（v2：按「供应商」分组，参考 CC Switch）
//
// 结构：providers[]（每个供应商 = 名称 + apiBase + apiKey + 该供应商下的模型）
//       + 全局默认模型（defaultKey = `${providerId}/${modelKey}`）
//
// - 独立 JSON 持久化（默认 `<cwd>/data/llm-models.json`），临时文件 + rename 原子写；
// - **密钥安全**：对外视图永不含 apiKey 明文，只给 hasKey + keyMask；
// - 旧版（v1：扁平的 models[] + defaultId）会自动迁移为 v2（按 apiBase 分组，模型 key 沿用旧 id）；
// - 权限：站主看全部；其他登录用户只看 `visibleToUsers` 的模型。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LlmModelEntryRecord {
  key: string
  /** 显示名（如 DeepSeek Chat） */
  name: string
  /** 模型 id（请求体 model，如 deepseek-chat） */
  model: string
  visibleToUsers: boolean
}

export interface LlmProviderRecord {
  id: string
  /** 供应商显示名（如 DeepSeek / OpenAI） */
  name: string
  /** OpenAI 兼容地址（不带 /chat/completions） */
  apiBase: string
  apiKey?: string
  models: LlmModelEntryRecord[]
  order: number
}

interface StoreFile {
  providers: LlmProviderRecord[]
  defaultKey: string
}

/** 对外视图（模型）：不含明文密钥 */
export interface LlmModelPublic {
  /** 全局唯一 id：`${providerId}/${modelKey}` */
  id: string
  providerId: string
  providerName: string
  name: string
  model: string
  apiBase: string
  visibleToUsers: boolean
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
  /** 扁平视图（便于选择器直接使用） */
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
  models?: LlmModelInput[]
  order?: number
}

export interface LlmModelRegistry {
  listAll(): LlmModelsPayload
  listPublic(role?: string): LlmModelsPayload
  /** 按模型全局 id 解析调用参数（兼容旧版仅 modelKey 的 id）；id 缺省 → 默认模型 */
  resolve(id?: string): { id: string; model: string; apiBase: string; apiKey?: string }
  save(input: { providers: LlmProviderInput[]; defaultKey: string }): LlmModelsPayload
  /** 供「一键获取模型列表」使用：按 providerId 取该供应商已存密钥（站主接口内部用） */
  keyOf(providerId: string): { apiBase: string; apiKey?: string } | undefined
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

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return ''
  }
}

/** 由 apiBase 猜一个供应商显示名（迁移/新卡片默认值用） */
export function guessProviderName(apiBase: string): string {
  const host = hostOf(apiBase).toLowerCase()
  const map: Record<string, string> = {
    'api.deepseek.com': 'DeepSeek',
    'api.openai.com': 'OpenAI',
    'api.siliconflow.cn': 'SiliconFlow',
    'api.moonshot.cn': 'Moonshot',
    'open.bigmodel.cn': '智谱',
    'dashscope.aliyuncs.com': '通义千问',
    'api.anthropic.com': 'Anthropic',
  }
  if (map[host]) return map[host]
  return host ? host.replace(/^api\./, '') : '默认供应商'
}

function uid(prefix: string, taken: Set<string>): string {
  let n = 1
  while (taken.has(`${prefix}${n}`)) n++
  const id = `${prefix}${n}`
  taken.add(id)
  return id
}

/** 把 v1（扁平 models[]）迁移为 v2（按 apiBase 分组） */
function migrateV1(raw: any): StoreFile | null {
  const old = raw?.models
  if (!Array.isArray(old) || !old.length) return null
  const groups = new Map<string, { name: string; apiBase: string; apiKey?: string; models: LlmModelEntryRecord[] }>()
  const providerIds = new Set<string>()
  for (const m of old) {
    const apiBase = String(m?.apiBase ?? '').trim()
    const gk = apiBase || '__default__'
    let g = groups.get(gk)
    if (!g) {
      g = { name: guessProviderName(apiBase), apiBase, models: [] }
      groups.set(gk, g)
    }
    if (!g.apiKey && m?.apiKey) g.apiKey = String(m.apiKey)
    g.models.push({
      key: String(m?.id ?? `m${g.models.length + 1}`),
      name: String(m?.name ?? m?.model ?? '模型'),
      model: String(m?.model ?? ''),
      visibleToUsers: m?.visibleToUsers !== false,
    })
  }
  const providers: LlmProviderRecord[] = []
  for (const [gk, g] of groups) {
    const id = gk === '__default__' ? uid('p', providerIds) : uid('p', providerIds)
    providers.push({ id, name: g.name, apiBase: g.apiBase, apiKey: g.apiKey, models: g.models, order: providers.length })
  }
  // 旧 defaultId 映射：找到包含该 modelKey 的供应商
  const oldDefault = String(raw?.defaultId ?? '')
  let defaultKey = ''
  for (const p of providers) {
    const hit = p.models.find((m) => m.key === oldDefault)
    if (hit) {
      defaultKey = `${p.id}/${hit.key}`
      break
    }
  }
  if (!defaultKey) defaultKey = `${providers[0].id}/${providers[0].models[0]?.key ?? 'm1'}`
  return { providers, defaultKey }
}

export interface ModelRegistryOptions {
  file: string
  /** 首次种子（来自 llm Config / .env）：生成一个「默认供应商 + 默认模型」 */
  seed: { model: string; apiBase?: string; apiKey?: string }
}

export function createModelRegistry(opts: ModelRegistryOptions): LlmModelRegistry {
  const file = opts.file
  let data: StoreFile | null = null

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

  function ensureLoaded(): StoreFile {
    if (data) return data
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as any
        if (Array.isArray(raw?.providers) && raw.providers.length) {
          data = normalize(raw)
          return data
        }
        const migrated = migrateV1(raw)
        if (migrated) {
          data = migrated
          persist(data)
          return data
        }
      }
    } catch (e) {
      console.warn('[llm] 模型清单损坏，将重新种子：', (e as Error)?.message)
    }
    // 首次种子：用当前 llm Config（通常来自 .env）生成默认供应商 + 默认模型
    const seed: StoreFile = {
      providers: [
        {
          id: 'p1',
          name: guessProviderName(opts.seed.apiBase ?? ''),
          apiBase: opts.seed.apiBase ?? '',
          apiKey: opts.seed.apiKey || undefined,
          order: 0,
          models: [
            {
              key: 'm1',
              name: `默认（${opts.seed.model}）`,
              model: opts.seed.model,
              visibleToUsers: true,
            },
          ],
        },
      ],
      defaultKey: 'p1/m1',
    }
    data = seed
    persist(seed)
    return data
  }

  function normalize(raw: any): StoreFile {
    const providers: LlmProviderRecord[] = (Array.isArray(raw?.providers) ? raw.providers : []).map((p: any, i: number) => ({
      id: String(p?.id || `p${i + 1}`),
      name: String(p?.name || guessProviderName(String(p?.apiBase ?? ''))),
      apiBase: String(p?.apiBase ?? '').trim(),
      apiKey: p?.apiKey ? String(p.apiKey) : undefined,
      order: typeof p?.order === 'number' ? p.order : i,
      models: (Array.isArray(p?.models) ? p.models : []).map((m: any, j: number) => ({
        key: String(m?.key || `m${j + 1}`),
        name: String(m?.name || m?.model || '模型'),
        model: String(m?.model ?? ''),
        visibleToUsers: m?.visibleToUsers !== false,
      })),
    }))
    const defaultKey = String(raw?.defaultKey ?? '')
    return { providers: providers.filter((p) => p.models.length), defaultKey }
  }

  function sortedProviders(list: LlmProviderRecord[]): LlmProviderRecord[] {
    return [...list].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  function toPublicProvider(p: LlmProviderRecord, models: LlmModelEntryRecord[]): LlmProviderPublic {
    const pubModels: LlmModelPublic[] = models.map((m) => ({
      id: `${p.id}/${m.key}`,
      providerId: p.id,
      providerName: p.name,
      name: m.name,
      model: m.model,
      apiBase: p.apiBase,
      visibleToUsers: m.visibleToUsers,
      hasKey: !!p.apiKey,
      keyMask: maskKey(p.apiKey),
      order: p.order,
    }))
    return {
      id: p.id,
      name: p.name,
      apiBase: p.apiBase,
      hasKey: !!p.apiKey,
      keyMask: maskKey(p.apiKey),
      order: p.order,
      models: pubModels,
    }
  }

  function payload(providers: LlmProviderPublic[], defaultKey: string): LlmModelsPayload {
    const flat = providers.flatMap((p) => p.models)
    const defaultId = flat.some((m) => m.id === defaultKey) ? defaultKey : (flat[0]?.id ?? '')
    return { providers, models: flat, defaultId }
  }

  function findModel(store: StoreFile, id: string): { p: LlmProviderRecord; m: LlmModelEntryRecord } | undefined {
    if (!id) return undefined
    for (const p of store.providers) {
      const [pid, mkey] = id.includes('/') ? [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)] : [id, '']
      if (mkey && p.id !== pid) continue
      const hit = mkey ? p.models.find((m) => m.key === mkey) : p.models.find((m) => m.key === id || m.model === id)
      if (hit) return { p, m: hit }
    }
    return undefined
  }

  return {
    listAll() {
      const d = ensureLoaded()
      const provs = sortedProviders(d.providers).map((p) => toPublicProvider(p, p.models))
      return payload(provs, d.defaultKey)
    },

    listPublic(role?: string) {
      const d = ensureLoaded()
      const isAdmin = role === 'admin'
      const provs = sortedProviders(d.providers)
        .map((p) => toPublicProvider(p, isAdmin ? p.models : p.models.filter((m) => m.visibleToUsers)))
        .filter((p) => p.models.length)
      const defaultId = isAdmin
        ? d.defaultKey
        : (provs.flatMap((p) => p.models).find((m) => m.id === d.defaultKey)?.id ?? '')
      return payload(provs, defaultId)
    },

    resolve(id) {
      const d = ensureLoaded()
      const found = findModel(d, id ?? '') ?? findModel(d, d.defaultKey) ?? (d.providers[0]?.models[0] ? { p: d.providers[0], m: d.providers[0].models[0] } : undefined)
      if (!found) throw new Error('未配置任何模型，请先在小知面板「⚙ 配置」中添加')
      return {
        id: `${found.p.id}/${found.m.key}`,
        model: found.m.model,
        apiBase: found.p.apiBase,
        apiKey: found.p.apiKey,
      }
    },

    save(input) {
      const d = ensureLoaded()
      const incoming = Array.isArray(input?.providers) ? input.providers : []
      if (!incoming.length) throw new Error('至少需要配置一个供应商')
      const provIds = new Set<string>()
      const next: LlmProviderRecord[] = incoming.map((p, i) => {
        const apiBase = String(p.apiBase ?? '').trim()
        if (!apiBase) throw new Error(`第 ${i + 1} 个供应商的 apiBase 不能为空`)
        if (!isHttpUrl(apiBase)) throw new Error(`第 ${i + 1} 个供应商的 apiBase 不是合法的 http(s) 地址`)
        const id = (() => {
          const base = String(p.id ?? '').trim() || `p${i + 1}`
          let rid = base
          let n = 2
          while (provIds.has(rid)) rid = `${base}-${n++}`
          provIds.add(rid)
          return rid
        })()
        const prev = d.providers.find((x) => x.id === id)
        let apiKey: string | undefined
        if (p.apiKey === null) apiKey = undefined
        else if (typeof p.apiKey === 'string' && p.apiKey.trim()) apiKey = p.apiKey.trim()
        else apiKey = prev?.apiKey
        const modelKeys = new Set<string>()
        const models = (Array.isArray(p.models) ? p.models : []).map((m, j) => {
          const model = String(m?.model ?? '').trim()
          if (!model) throw new Error(`供应商「${p.name || apiBase}」下第 ${j + 1} 个模型的模型 id 不能为空`)
          const base = String(m?.key ?? '').trim() || `m${j + 1}`
          let key = base
          let n = 2
          while (modelKeys.has(key)) key = `${base}-${n++}`
          modelKeys.add(key)
          return {
            key,
            name: String(m?.name ?? '').trim() || model,
            model,
            visibleToUsers: m?.visibleToUsers !== false,
          }
        })
        if (!models.length) throw new Error(`供应商「${p.name || apiBase}」至少需要一个模型`)
        return {
          id,
          name: String(p.name ?? '').trim() || guessProviderName(apiBase),
          apiBase,
          apiKey,
          models,
          order: typeof p.order === 'number' ? p.order : i,
        }
      })
      const defaultKey = String(input.defaultKey ?? '').trim()
      const flatIds = next.flatMap((p) => p.models.map((m) => `${p.id}/${m.key}`))
      if (!defaultKey || !flatIds.includes(defaultKey)) throw new Error('默认模型必须是列表中的一个模型')
      const store: StoreFile = { providers: next, defaultKey }
      persist(store)
      data = store
      const provs = sortedProviders(store.providers).map((p) => toPublicProvider(p, p.models))
      return payload(provs, store.defaultKey)
    },

    keyOf(providerId) {
      const d = ensureLoaded()
      const p = d.providers.find((x) => x.id === providerId)
      if (!p) return undefined
      return { apiBase: p.apiBase, apiKey: p.apiKey }
    },
  }
}
