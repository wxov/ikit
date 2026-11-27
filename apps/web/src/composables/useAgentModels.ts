// 小知 · 模型选择 / 模型配置（P2-10 前端拆分，2026-11-28）
//
// 从 DocCuratorPanel.vue 抽出的脚本逻辑（template 未变）：模型清单加载、按会话回显、
// 站主模型配置弹窗（供应商分组）与「一键获取模型列表」。纯状态 + API 调用，无模板依赖。
import { ref, type Ref } from 'vue'
import { listModels, saveModels, fetchModelList, type LlmModelPublic } from '../lib/llm'

export interface AgentSession {
  id: string
  ownerId?: string
  title: string
  /** 该会话选用的模型（llm 模型清单记录 id；缺省 = 默认模型） */
  model?: string
  createdAt: string
  updatedAt: string
}

export type { ModelRow, ProviderRow } from '../lib/agentModels'
export { compositeOf, providersFrom } from '../lib/agentModels'
import { compositeOf, providersFrom, type ModelRow, type ProviderRow } from '../lib/agentModels'
export interface FetchRow {
  id: string
  name: string
  exists: boolean
  checked: boolean
}


export interface UseAgentModelsOptions {  loggedIn: Ref<boolean>
  isAdmin: Ref<boolean>
  sessions: Ref<AgentSession[]>
  currentId: Ref<string>
}

export function useAgentModels({ loggedIn, sessions, currentId }: UseAgentModelsOptions) {
  const models = ref<LlmModelPublic[]>([])
  const defaultModelId = ref('')
  const selectedModel = ref('')
  const modelsError = ref('')

  async function loadModels() {
    if (!loggedIn.value) return
    try {
      const r = await listModels()
      models.value = r.models
      defaultModelId.value = r.defaultId || r.models[0]?.id || ''
      // 当前选中模型若已失效（被删除/无权），回落到默认
      if (!models.value.some((m) => m.id === selectedModel.value)) {
        const cur = sessions.value.find((s) => s.id === currentId.value)?.model
        selectedModel.value = models.value.some((m) => m.id === cur) ? (cur as string) : defaultModelId.value
      }
      modelsError.value = ''
    } catch (e: any) {
      modelsError.value = e?.message ?? String(e)
    }
  }

  /** 切换会话/新建后，回显该会话记住的模型（缺省用默认模型） */
  function syncModelFromSession() {
    const cur = sessions.value.find((s) => s.id === currentId.value)?.model
    selectedModel.value = cur && models.value.some((m) => m.id === cur) ? cur : defaultModelId.value
  }

  // ---- 模型配置（站主）：按「供应商」分组（参考 CC Switch）----
  const configOpen = ref(false)
  const configProviders = ref<ProviderRow[]>([])
  const configDefaultId = ref('')
  const configLoading = ref(false)
  const configSaving = ref(false)
  const configNotice = ref('')

  const fetchOpen = ref(false)
  const fetchProviderIdx = ref(-1)
  const fetchLoading = ref(false)
  const fetchError = ref('')
  const fetchManual = ref('')
  const fetchList = ref<FetchRow[]>([])

  /** 打开模型配置弹窗（站主）：读取当前清单 */
  async function openModelConfig() {
    configOpen.value = true
    configLoading.value = true
    configNotice.value = ''
    modelsError.value = ''
    try {
      const r = await listModels()
      configProviders.value = providersFrom(r.providers)
      configDefaultId.value = r.defaultId || ''
    } catch (e: any) {
      modelsError.value = e?.message ?? String(e)
    } finally {
      configLoading.value = false
    }
  }

  function addProvider() {
    configProviders.value.push({
      id: '',
      name: '',
      apiBase: '',
      apiKey: '',
      keyMask: '',
      hasKey: false,
      models: [{ key: '', name: '', model: '', visibleToUsers: true }],
    })
  }

  function removeProvider(i: number) {
    configProviders.value.splice(i, 1)
    const flat = configProviders.value.flatMap((p) => p.models.map((m) => compositeOf(p, m)))
    if (!flat.includes(configDefaultId.value)) configDefaultId.value = flat[0] ?? ''
  }

  function addModel(pi: number) {
    configProviders.value[pi].models.push({ key: '', name: '', model: '', visibleToUsers: true })
  }

  function removeModel(pi: number, mi: number) {
    const p = configProviders.value[pi]
    const removed = compositeOf(p, p.models[mi])
    p.models.splice(mi, 1)
    if (configDefaultId.value === removed) {
      const flat = configProviders.value.flatMap((x) => x.models.map((m) => compositeOf(x, m)))
      configDefaultId.value = flat[0] ?? ''
    }
  }

  /** 打开「一键获取模型列表」 */
  function openFetch(pi: number) {
    fetchProviderIdx.value = pi
    fetchOpen.value = true
    fetchError.value = ''
    fetchManual.value = ''
    fetchList.value = []
  }

  /** 调用后端代理 GET {apiBase}/models（用该供应商填写的密钥，或已保存的密钥） */
  async function doFetch() {
    const p = configProviders.value[fetchProviderIdx.value]
    if (!p) return
    fetchLoading.value = true
    fetchError.value = ''
    try {
      const r = await fetchModelList({
        apiBase: p.apiBase.trim(),
        apiKey: p.apiKey.trim() || undefined,
        providerId: p.id || undefined,
      })
      fetchList.value = r.models.map((m) => {
        const exists = p.models.some((x) => x.model === m.id)
        return { id: m.id, name: m.name || m.id, exists, checked: !exists }
      })
      if (!fetchList.value.length) fetchError.value = '该供应商未返回任何模型'
    } catch (e: any) {
      fetchError.value = e?.message ?? String(e)
    } finally {
      fetchLoading.value = false
    }
  }

  function toggleAllFetch(v: boolean) {
    fetchList.value = fetchList.value.map((x) => ({ ...x, checked: v }))
  }

  /** 把勾选的模型 / 手动输入的模型 id 加入该供应商 */
  function applyFetch() {
    const p = configProviders.value[fetchProviderIdx.value]
    if (!p) return
    const add: ModelRow[] = []
    for (const f of fetchList.value) {
      if (f.checked && !p.models.some((x) => x.model === f.id) && !add.some((x) => x.model === f.id)) {
        add.push({ key: '', name: f.id, model: f.id, visibleToUsers: true })
      }
    }
    const manual = fetchManual.value
      .split(/[\s,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    for (const id of manual) {
      if (!p.models.some((x) => x.model === id) && !add.some((x) => x.model === id)) {
        add.push({ key: '', name: id, model: id, visibleToUsers: true })
      }
    }
    p.models.push(...add)
    fetchOpen.value = false
  }

  async function saveModelConfig() {
    const flat = configProviders.value.flatMap((p) => p.models.map((m) => compositeOf(p, m)))
    const defaultKey = flat.includes(configDefaultId.value) ? configDefaultId.value : (flat[0] ?? '')
    configSaving.value = true
    configNotice.value = ''
    modelsError.value = ''
    try {
      const r = await saveModels({
        providers: configProviders.value.map((p, i) => ({
          id: p.id,
          name: p.name.trim() || undefined,
          apiBase: p.apiBase.trim(),
          apiKey: p.apiKey.trim() ? p.apiKey.trim() : undefined,
          models: p.models.map((m) => ({
            key: m.key,
            name: m.name.trim() || m.model.trim(),
            model: m.model.trim(),
            visibleToUsers: m.visibleToUsers,
          })),
          order: i,
        })),
        defaultKey,
      })
      configProviders.value = providersFrom(r.providers)
      configDefaultId.value = r.defaultId
      configNotice.value = '已保存'
      await loadModels()
      if (!models.value.some((m) => m.id === selectedModel.value)) selectedModel.value = defaultModelId.value
    } catch (e: any) {
      modelsError.value = e?.message ?? String(e)
    } finally {
      configSaving.value = false
    }
  }

  return {
    models,
    defaultModelId,
    selectedModel,
    modelsError,
    loadModels,
    syncModelFromSession,
    configOpen,
    configProviders,
    configDefaultId,
    configLoading,
    configSaving,
    configNotice,
    fetchOpen,
    fetchProviderIdx,
    fetchLoading,
    fetchError,
    fetchManual,
    fetchList,
    openModelConfig,
    addProvider,
    removeProvider,
    addModel,
    removeModel,
    openFetch,
    doFetch,
    toggleAllFetch,
    applyFetch,
    saveModelConfig,
  }
}

