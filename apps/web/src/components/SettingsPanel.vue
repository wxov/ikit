<script setup lang="ts">
import { computed, inject, ref, onMounted, type Ref } from 'vue'
import { api } from '../lib/api'
import { listModels, saveModels, type LlmModelPublic } from '../lib/llm'
import { fetchUpdateManifest, hasUpdate as hasUpdateFn, detectPlatform, type UpdateInfo } from '../lib/update'

const emit = defineEmits<{ (e: 'close'): void; (e: 'request-update', info: UpdateInfo): void }>()
const tab = ref<'update' | 'about' | 'help' | 'models'>('update')
const userRole = inject<Ref<string>>('userRole', ref('guest'))
const isAdmin = computed(() => userRole.value === 'admin')

// ---- 模型配置（仅站主）：小知可选模型清单 ----
interface ModelRow {
  id: string
  name: string
  model: string
  apiBase: string
  apiKey: string
  keyMask: string
  hasKey: boolean
  visibleToUsers: boolean
}
const rows = ref<ModelRow[]>([])
const defaultId = ref('')
const modelsLoading = ref(false)
const modelsSaving = ref(false)
const modelsError = ref('')
const modelsNotice = ref('')

function toRows(list: LlmModelPublic[]): ModelRow[] {
  return list.map((m) => ({
    id: m.id,
    name: m.name,
    model: m.model,
    apiBase: m.apiBase ?? '',
    apiKey: '',
    keyMask: m.keyMask,
    hasKey: m.hasKey,
    visibleToUsers: m.visibleToUsers,
  }))
}

async function loadModels() {
  if (!isAdmin.value) return
  modelsLoading.value = true
  modelsError.value = ''
  modelsNotice.value = ''
  try {
    const r = await listModels()
    rows.value = toRows(r.models)
    defaultId.value = r.defaultId || r.models[0]?.id || ''
  } catch (e: any) {
    modelsError.value = e?.message ?? String(e)
  } finally {
    modelsLoading.value = false
  }
}

function addModel() {
  rows.value.push({ id: '', name: '', model: '', apiBase: '', apiKey: '', keyMask: '', hasKey: false, visibleToUsers: true })
}

function removeModel(i: number) {
  rows.value.splice(i, 1)
  if (!rows.value.some((r) => r.id === defaultId.value)) defaultId.value = rows.value[0]?.id ?? ''
}

async function saveModelList() {
  modelsSaving.value = true
  modelsError.value = ''
  modelsNotice.value = ''
  try {
    const r = await saveModels({
      models: rows.value.map((row, i) => ({
        id: row.id,
        name: row.name.trim(),
        model: row.model.trim(),
        apiBase: row.apiBase.trim() || undefined,
        // 留空 = 保留原密钥（服务端语义）；输入即更新
        apiKey: row.apiKey.trim() ? row.apiKey.trim() : undefined,
        visibleToUsers: row.visibleToUsers,
        order: i,
      })),
      defaultId: defaultId.value,
    })
    rows.value = toRows(r.models)
    defaultId.value = r.defaultId
    modelsNotice.value = '已保存'
  } catch (e: any) {
    modelsError.value = e?.message ?? String(e)
  } finally {
    modelsSaving.value = false
  }
}
const info = ref<UpdateInfo | null>(null)
const checking = ref(false)
const checked = ref(false)
const system = ref<{ name?: string; version?: string } | null>(null)
const platform = detectPlatform()

async function checkUpdate() {
  checking.value = true
  checked.value = true
  try {
    info.value = await fetchUpdateManifest()
  } finally {
    checking.value = false
  }
}

function openUpdate() {
  if (info.value) emit('request-update', info.value)
}

async function loadSystem() {
  try {
    const r = await api<{ name?: string; version?: string }>('/api/system/info')
    system.value = r
  } catch {
    system.value = null
  }
}

onMounted(() => {
  checkUpdate()
  loadSystem()
  if (isAdmin.value) loadModels()
})

const FAQS: Array<[string, string]> = [
  ['如何使用知识库？', '在首页卡片流或左栏目录中点击文章阅读；站主可点「新建文章」或目录「＋/⋯」管理，支持 Markdown 与封面图。'],
  ['如何评论 / 评分？', '打开文章后在评论区发表评论（需登录）；评分/点赞/浏览在卡片与详情页展示。'],
  ['怎么搜索？', '顶栏全局搜索（Ctrl+K），支持按标题/标签匹配；右侧「分类」「标签云」可快速筛选。'],
  ['如何回收/恢复文章？', '删除的文章进入左栏「回收站」，站主可恢复或彻底删除；「归档」按时间浏览全部文章。'],
  ['账号如何创建？', '注册已关闭，由站主在「用户管理」中手动添加；登录后可在头像菜单「编辑资料」改用户名/密码。'],
  ['如何安装新插件？', '站主进入「商店」安装/更新/卸载；安装后页面自动刷新，可在「插件」管理中启停与调整可见性。'],
]
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-panel">
      <header class="st-head">
        <h3>设置</h3>
        <button class="st-x" @click="emit('close')">×</button>
      </header>
      <nav class="st-tabs">
        <button :class="{ on: tab === 'update' }" @click="tab = 'update'">检查更新</button>
        <button :class="{ on: tab === 'about' }" @click="tab = 'about'">关于</button>
        <button :class="{ on: tab === 'help' }" @click="tab = 'help'">帮助</button>
        <button v-if="isAdmin" :class="{ on: tab === 'models' }" @click="tab = 'models'; loadModels()">模型配置</button>
      </nav>

      <section v-if="tab === 'update'" class="st-body">
        <div class="up-row">
          <span class="up-version">当前版本 <b>v{{ info?.currentVersion ?? '…' }}</b></span>
          <span class="up-version latest">最新版本 <b>v{{ info?.latest ?? '…' }}</b></span>
          <button class="st-btn" :disabled="checking" @click="checkUpdate">{{ checking ? '检查中…' : '检查更新' }}</button>
        </div>
        <div v-if="checked && info" class="up-result" :class="{ ok: !hasUpdateFn(info), bad: hasUpdateFn(info) }">
          <template v-if="hasUpdateFn(info)">
            发现新版本 v{{ info.latest }}，<a class="up-link" @click="openUpdate">更新</a>
          </template>
          <template v-else>已是最新版本（v{{ info.latest }}）</template>
        </div>
        <p class="up-note">构建时间：{{ info?.buildTime ?? '—' }} · 平台：{{ platform }}</p>
      </section>

      <section v-else-if="tab === 'about'" class="st-body">
        <div class="about-box">
          <div class="about-logo">🧠 i-kit</div>
          <div class="about-name">知识门户</div>
          <div class="about-meta">版本 v{{ info?.currentVersion ?? system?.version ?? '0.2.0' }}</div>
          <p class="about-desc">
            机器人 + Web 服务 + AI Agent 成套项目，基于自研 Cordis 插件架构；知识库 / 小知（DocCurator）/ 插件商店 /
            多角色权限，Web / 桌面（Tauri）/ 移动（Capacitor）三端同源。
          </p>
          <div class="about-meta">GitHub：<a class="up-link" href="https://github.com/wxov/ikit" target="_blank" rel="noopener">github.com/wxov/ikit</a></div>
        </div>
      </section>

      <section v-else-if="tab === 'help'" class="st-body">
        <div class="faq-list">
          <details v-for="[q, a] in FAQS" :key="q" class="faq-item">
            <summary class="faq-q">{{ q }}</summary>
            <p class="faq-a">{{ a }}</p>
          </details>
        </div>
      </section>

      <!-- 模型配置（仅站主）：小知可选模型清单；密钥只保存于服务端，界面仅显示掩码 -->
      <section v-else-if="tab === 'models'" class="st-body">
        <p class="md-hint">
          「小知」可用的模型清单。密钥<b>只保存在服务端</b>，这里只显示掩码；<b>留空表示不修改</b>已有密钥。
          未单独配置密钥的模型，会回落到服务端 <code>.env</code> 的 <code>LLM_API_KEY</code>。
        </p>
        <div v-if="!isAdmin" class="md-error">仅站主可配置模型。</div>
        <div v-else-if="modelsLoading" class="md-hint">加载中…</div>
        <div v-else class="md-list">
          <div v-for="(m, i) in rows" :key="i" class="md-row">
            <label class="md-def" :title="m.id ? '设为默认模型' : '新模型保存后才能设为默认'">
              <input type="radio" :checked="defaultId === m.id" :disabled="!m.id" @change="defaultId = m.id" /> 默认
            </label>
            <input v-model="m.name" class="md-input" placeholder="显示名（如 DeepSeek Chat）" />
            <input v-model="m.model" class="md-input" placeholder="模型 id（如 deepseek-chat）" />
            <input v-model="m.apiBase" class="md-input" placeholder="apiBase（可选，默认用服务端配置）" />
            <input
              v-model="m.apiKey"
              class="md-input"
              type="password"
              :placeholder="m.hasKey ? '已保存 ' + m.keyMask + '，留空不修改' : 'API Key（可选）'"
            />
            <label class="md-chk"><input type="checkbox" v-model="m.visibleToUsers" /> 对普通用户可见</label>
            <button class="md-del" title="删除该模型" @click="removeModel(i)">删除</button>
          </div>
          <div class="md-actions">
            <button class="st-btn" @click="addModel">＋ 添加模型</button>
            <button class="st-btn" :disabled="modelsSaving" @click="saveModelList">
              {{ modelsSaving ? '保存中…' : '保存' }}
            </button>
          </div>
          <div v-if="modelsError" class="md-error">❌ {{ modelsError }}</div>
          <div v-if="modelsNotice" class="md-ok">✅ {{ modelsNotice }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed; inset: 0; z-index: 650;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.settings-panel {
  width: 520px; max-width: 100%; max-height: 80vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 20px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}
.st-head { display: flex; align-items: center; justify-content: space-between; }
.st-head h3 { margin: 0; }
.st-x { border: none; background: transparent; color: var(--muted); font-size: 24px; cursor: pointer; line-height: 1; }
.st-tabs { display: flex; gap: 4px; margin: 14px 0; border-bottom: 1px solid var(--border); }
.st-tabs button {
  border: none; background: transparent; color: var(--muted); padding: 8px 14px;
  border-radius: 8px 8px 0 0; font-size: 13px; cursor: pointer; font-family: inherit;
  border-bottom: 2px solid transparent;
}
.st-tabs button.on { color: var(--primary-dark); font-weight: 600; border-bottom-color: var(--primary); }
.st-body { padding-top: 4px; }
.up-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.up-version { font-size: 13px; color: var(--muted); }
.up-version b { color: var(--text); }
.up-version.latest b { color: var(--primary-dark); }
.up-result { margin-top: 12px; font-size: 13px; }
.up-result.ok { color: var(--ok); }
.up-result.bad { color: var(--warn); }
.up-note { margin-top: 10px; font-size: 11px; color: var(--muted); }
.up-link { color: var(--primary-dark); cursor: pointer; text-decoration: underline; }
.st-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.st-btn:disabled { opacity: 0.6; }
.about-box { text-align: center; padding: 8px 0; }
.about-logo { font-size: 34px; }
.about-name { font-size: 18px; font-weight: 700; margin-top: 4px; }
.about-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
.about-desc { font-size: 13px; color: var(--text); line-height: 1.8; margin: 12px auto 0; max-width: 420px; text-align: left; }
.faq-list { display: flex; flex-direction: column; gap: 10px; }
.faq-item { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; background: var(--bg); }
.faq-q { font-size: 13px; font-weight: 600; cursor: pointer; }
.faq-a { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 6px 0 0; }

/* ---- 模型配置（仅站主）---- */
.md-hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0 0 10px; }
.md-hint code { background: var(--primary-soft); padding: 0 4px; border-radius: 4px; }
.md-list { display: flex; flex-direction: column; gap: 8px; }
.md-row {
  display: grid;
  grid-template-columns: 62px minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1.2fr) auto auto;
  gap: 6px; align-items: center;
  border: 1px solid var(--border); border-radius: 8px; padding: 8px;
}
.md-input {
  width: 100%; min-width: 0; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px;
  font-size: 12px; font-family: inherit; background: var(--panel); color: var(--text);
}
.md-def, .md-chk { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.md-del {
  border: 1px solid var(--danger, #dc2626); color: var(--danger, #dc2626);
  background: transparent; border-radius: 6px; padding: 4px 8px; font-size: 12px;
  cursor: pointer; font-family: inherit;
}
.md-actions { display: flex; gap: 8px; margin-top: 4px; }
.md-error { font-size: 12px; color: var(--danger, #dc2626); line-height: 1.6; }
.md-ok { font-size: 12px; color: var(--primary-dark); }
@media (max-width: 900px) {
  .md-row { grid-template-columns: 1fr 1fr; }
  .md-row .md-input { grid-column: auto; }
}
</style>
