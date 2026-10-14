<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide } from 'vue'
import { createSocket, api, type EventItem, type WsMessage, type WsStatus } from './lib/api'
import { createWsConflictGate, type WsConflictState } from './lib/wsConflict'
import {
  fetchUpdateManifest,
  hasUpdate as hasUpdateFn,
  type UpdateInfo,
} from './lib/update'
import { getToken, setToken, logout, currentUser, authHeaders, type PublicUser } from './lib/auth'
import { startDesktopNode } from './lib/agentNode'
import type { PluginRecord, PluginRole, VisiblePlugins } from './lib/plugins'
import SystemPanel from './components/SystemPanel.vue'
import AgentPanel from './components/AgentPanel.vue'
import PluginSettings from './components/PluginSettings.vue'
import PluginStore from './components/PluginStore.vue'
import StorePluginPanel from './components/StorePluginPanel.vue'
import UserManager from './components/UserManager.vue'
import AuthPanel from './components/AuthPanel.vue'
import ContentCardFeed from './components/ContentCardFeed.vue'
import PortalRight from './components/PortalRight.vue'
import ArticleDetail from './components/ArticleDetail.vue'
import ArticleEditView from './components/ArticleEditView.vue'
import DocTree from './components/DocTree.vue'
import ArchiveView from './components/ArchiveView.vue'
import TrashView from './components/TrashView.vue'
import UserProfile from './components/UserProfile.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import ImportDocsDialog from './components/ImportDocsDialog.vue'

// role 决定前台功能区可见插件；'manager' 为站主专用插件管理页；'users' 为站主用户管理
type Tab = string

const HOME_TAB = 'home'
const tab = ref<Tab>(HOME_TAB)
const adminOpen = ref(false)
const avatarOpen = ref(false)
const globalQ = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const wsStatus = ref<WsStatus>('connecting')
const events = ref<EventItem[]>([])

// 站主管理页：与功能插件分开的独立分组
const ADMIN_TABS: { key: string; label: string; icon: string }[] = [
  { key: 'system', label: '系统', icon: '⚙️' },
  { key: 'manager', label: '插件', icon: '🧩' },
  { key: 'store', label: '商店', icon: '🛍️' },
  { key: 'users', label: '用户', icon: '👥' },
]
function isAdminTab(t: string): boolean {
  return ADMIN_TABS.some((a) => a.key === t)
}
function chooseAdmin(t: string) {
  tab.value = t
  adminOpen.value = false
}
function toggleMobileAdmin() {
  adminOpen.value = !adminOpen.value
}

// 账号：默认未登录（guest），登录后用真实 token 解析角色
const user = ref<import('./lib/auth').PublicUser | null>(null)
const role = ref<PluginRole>('guest')
const plugins = ref<PluginRecord[]>([])
const showAuth = ref(false)
const categories = ref<import('./lib/api').CategoryNode[]>([])

// 扁平化分类树为路径列表（供编辑器分类下拉提示）
const categoryPaths = computed<string[]>(() => {
  const out: string[] = []
  const walk = (nodes: import('./lib/api').CategoryNode[]) => {
    for (const n of nodes) {
      out.push(n.path)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(categories.value)
  return out
})

let authToken = ''

// 桌面端节点：登录后注册并心跳（Tauri 环境才生效）
let stopNode: (() => void) | null = null
function ensureNode() {
  if (stopNode) return
  stopNode = startDesktopNode()
}
function stopDesktopNode() {
  stopNode?.()
  stopNode = null
}

async function loadCategories() {
  try {
    const r = await api<{ categories: import('./lib/api').CategoryNode[] }>(
      '/api/knowledge/categories',
      // 带 token：否则站主也会按 guest 过滤，看不到草稿/私有文章的分类（方案 F2）
      { headers: authHeaders() },
    )
    categories.value = r.categories
  } catch {
    categories.value = []
  }
}

async function refreshPlugins() {
  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined
    const r = await api<VisiblePlugins>(`/api/plugins/visible`, { headers })
    plugins.value = r.plugins
    const visible = plugins.value.map((p) => p.name ?? '')
    const isAdmin = user.value?.role === 'admin'
    const valid =
      isAdminTab(tab.value) ||
      visible.includes(tab.value) ||
      tab.value === HOME_TAB ||
      tab.value === 'archive' ||
      tab.value === 'trash' ||
      isStorePlugin(tab.value)
    if (!valid) {
      tab.value = isAdmin ? 'system' : HOME_TAB
    }
  } catch (e) {
    console.warn('[plugins] load failed:', e)
    plugins.value = []
  }
}

// 登录/注册成功后：更新真实用户与角色
function onAuthed(u: { role: string }) {
  user.value = u as any
  authToken = getToken() ?? ''
  role.value = (u.role as PluginRole) || 'guest'
  showAuth.value = false
  ensureNode()
  refreshPlugins()
}

function onProfileUpdated(u: import('./lib/auth').PublicUser) {
  user.value = u
  role.value = (u.role as PluginRole) || 'guest'
  ensureNode()
  refreshPlugins()
}

async function doLogout() {
  try {
    await logout()
  } catch (e) {
    console.warn(e)
  }
  setToken(null)
  user.value = null
  authToken = ''
  role.value = 'guest'
  stopDesktopNode()
  if (tab.value === 'manager' || tab.value === 'users') tab.value = 'system'
  refreshPlugins()
}

// 是否为商店/第三方可加载插件面板
const STORE_PANELS = ['stats', 'notes', 'calendar', 'todo', 'weather', 'rss', 'mdclip', 'hello']
function isStorePlugin(t: string): boolean {
  return STORE_PANELS.includes(t)
}

// 前台功能入口 = 插件（默认功能已并入知识门户）
const features = computed<PluginRecord[]>(() => plugins.value)

/**
 * 插件排序「实时预览」：仅本地按名字序列稳定重排 `plugins.value`（不发请求）。
 * 顶部功能 nav（:383-391）与移动端 tabbar（:567-575）顺序由 plugins.value 决定 → 自动跟随。
 * 不在 names 中的插件保持相对位置并排在其后。
 */
function previewPluginOrder(names: string[]) {
  const rank = new Map(names.map((n, i) => [n, i]))
  plugins.value = [...plugins.value]
    .map((p, i) => ({ p, i, r: rank.get(p.name) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p)
}
// 详情页状态机（完善⑦）：list=卡片流 / read=阅读态 / edit=编辑已有文章 / new=空白草稿
type DetailMode = 'list' | 'read' | 'edit' | 'new'
const article = ref<import('./lib/api').KnowledgeEntry | null>(null)
const detailMode = ref<DetailMode>('list')
/** new 态：目录树「＋ 新建子文档」传来的挂载父档 */
const draftParentId = ref<string | ''>('')
/** 编辑态组件实例 key：让「新建草稿 → 首次保存创建」不重挂载（否则丢失正在输入的内容） */
const editKey = ref(0)
const editViewRef = ref<InstanceType<typeof ArticleEditView> | null>(null)
const docTreeKey = ref(0)
// 批量导入入口（仅站主）
const importOpen = ref(false)
// 导入挂载目标父文档：导入完成后用于目录树自动展开并定位
const importTargetParentId = ref('')
// 知识库数据版本：导入后自增，用于重挂载卡片流/右栏/目录树以重新拉取
const dataKey = ref(0)
// 全局筛选：分类 / 标签（来自右栏，联动中栏卡片流与左栏目录）
const filterCat = ref('')
const filterTag = ref('')
// 设置 / 编辑资料弹窗
const settingsOpen = ref(false)
const profileOpen = ref(false)
// 窄屏侧栏抽屉（<1200px 时左右侧栏收纳为抽屉）
const sideLeftOpen = ref(false)
const sideRightOpen = ref(false)

// 全局轻提示（发布/撤回等反馈；非弹窗）
const appToast = ref('')
let appToastTimer: ReturnType<typeof setTimeout> | null = null
function showAppToast(msg: string) {
  appToast.value = msg
  if (appToastTimer) clearTimeout(appToastTimer)
  appToastTimer = setTimeout(() => (appToast.value = ''), 3000)
}

/** 编辑态是否活跃 */
const inEditMode = computed(() => detailMode.value === 'edit' || detailMode.value === 'new')

// ---- 多端联动（AC-24）：他端修改 → 顶部提示条（非弹窗），**绝不覆盖当前输入** ----
// 判定逻辑（回声抑制两道闸 / 触发条件）见 `lib/wsConflict.ts`（纯逻辑，可无头实测）；
// 本组件只做接线：提示条 UI + 阅读态「重新载入」（显式拉取最新并替换显示）。
const wsConflict = ref<WsConflictState | null>(null)
const wsGate = createWsConflictGate({
  currentId: () => article.value?.id ?? null,
  currentUpdatedAt: () => article.value?.updatedAt ?? null,
  // 第 2 轮口径（R2-2）：提示条**仅站主（admin）**可见；游客 / 登录非站主完全不提示
  canPrompt: () => user.value?.role === 'admin',
  onConflict: (s) => (wsConflict.value = s),
})

/** 提示条文案：他端删除（remove）与普通修改文案不同；编辑/新建态追加「你的修改仍在保存中」 */
const wsConflictText = computed(() => {
  const s = wsConflict.value
  if (!s) return ''
  if (s.kind === 'remove') {
    return inEditMode.value
      ? '该文章已被删除或移入回收站；你的修改仍在保存中'
      : '该文章已被删除或移入回收站'
  }
  return inEditMode.value ? '该文章已在其它端被修改；你的修改仍在保存中' : '该文章已在其它端被修改'
})

/** 本端即将写入（ArticleEditView 的 `writing` 事件）：刷新回声保护窗 */
function onLocalWrite() {
  wsGate.noteLocalWrite()
}

/** 本端写入成功后的本地同步：回写 article，并按 updatedAt 指纹撤回误报的冲突提示条 */
function syncLocalEntry(entry: import('./lib/api').KnowledgeEntry) {
  article.value = entry
  wsGate.noteLocalSaved(entry)
}

/** 切换文章 / 离开详情 / 删除后：清提示条 **并重置**「已提示过的版本」记录 */
function clearWsConflict() {
  wsGate.clear()
}

/** 用户收起提示条（「继续编辑」/「×」）：只收条，保留版本记录 → 同一 updatedAt 不会复弹（R2-2） */
function dismissWsConflict() {
  wsGate.dismiss()
}

/**
 * 他端把当前文章软删除（移入回收站）→ 「返回列表」。
 * 编辑态先尽力 flush 一次（PATCH 仍会写入该已进回收站的条目，不丢内容），但**不因失败把用户困在编辑态**
 * （失败时内容仍在 localStorage 快照里）。
 */
async function wsBackToList() {
  if (inEditMode.value) await editViewRef.value?.flush()
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
  docTreeKey.value++
  dataKey.value++
}

/** WS 回调：仅 `knowledge:changed`（`update`/`create`）且命中当前文章时才可能提示 */
function onKnowledgeChanged(msg: WsMessage) {
  wsGate.handleMessage(msg)
}

/** 阅读态「重新载入」：显式拉取最新版本并替换显示（站主带 token 才看得到自己的草稿） */
async function reloadLatest() {
  const id = wsConflict.value?.id ?? article.value?.id
  if (!id) return
  try {
    const r = await api<{ entries: import('./lib/api').KnowledgeEntry[] }>('/api/knowledge/entries', {
      headers: authHeaders(),
    })
    const latest = (r.entries ?? []).find((e) => e.id === id)
    clearWsConflict()
    if (!latest) {
      showAppToast('该文章已被撤回或删除')
      article.value = null
      detailMode.value = 'list'
      dataKey.value++
      return
    }
    article.value = latest
    showAppToast('已载入最新版本')
  } catch (e: any) {
    showAppToast(`载入失败：${e?.message ?? e}`)
  }
}

/** 离开编辑态 / 跳转前先把内容 flush 到服务端；失败则留在编辑态（不静默丢内容） */
async function flushCurrent(): Promise<boolean> {
  if (!inEditMode.value) return true
  const ok = (await editViewRef.value?.flush()) ?? true
  if (!ok) showAppToast('保存失败，已留在编辑态')
  return ok
}

// 门户首页（知识卡片流）
async function goHome() {
  if (!(await flushCurrent())) return
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
  globalQ.value = ''
  filterCat.value = ''
  filterTag.value = ''
  tab.value = HOME_TAB
}
async function onFilterCategory(path: string) {
  if (!(await flushCurrent())) return
  filterCat.value = path
  filterTag.value = ''
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
  tab.value = HOME_TAB
}
async function onFilterTag(tag: string) {
  if (!(await flushCurrent())) return
  filterTag.value = tag
  filterCat.value = ''
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
  tab.value = HOME_TAB
}
function onClearFilter() {
  filterCat.value = ''
  filterTag.value = ''
}
async function onOpenEntry(e: import('./lib/api').KnowledgeEntry) {
  if (!(await flushCurrent())) return
  article.value = e
  detailMode.value = 'read'
  clearWsConflict() // 换了一篇文章 → 旧的多端提示条作废
  localStorage.setItem('ikit-kb-selected', e.id)
  tab.value = HOME_TAB
}
async function onSelectTag(tag: string) {
  if (!(await flushCurrent())) return
  globalQ.value = tag
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
  tab.value = HOME_TAB
}
function backToList() {
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
}

/** 进入编辑态（已有文章，就地编辑，无弹窗） */
async function enterEdit(entry: import('./lib/api').KnowledgeEntry) {
  if (user.value?.role !== 'admin') {
    alert('仅站主可编辑文章')
    return
  }
  if (!(await flushCurrent())) return
  article.value = entry
  draftParentId.value = ''
  editKey.value++
  detailMode.value = 'edit'
  tab.value = HOME_TAB
}

/** 进入「新建文章」= 详情页空白草稿编辑态（parentId 来自目录树「＋ 新建子文档」） */
async function enterNew(parentId?: string) {
  if (user.value?.role !== 'admin') {
    alert('仅站主可编辑文章')
    return
  }
  if (!(await flushCurrent())) return
  article.value = null
  draftParentId.value = parentId ?? ''
  editKey.value++
  detailMode.value = 'new'
  tab.value = HOME_TAB
}

/** 首次自动保存创建成功：拿到真实 id，目录树出现新条目 */
function onDraftCreated(entry: import('./lib/api').KnowledgeEntry) {
  syncLocalEntry(entry)
  clearWsConflict()
  detailMode.value = 'edit'
  docTreeKey.value++
}
/** 后续 PATCH 成功：只同步本地对象（不 dataKey++，避免编辑中列表重排） */
function onSaved(entry: import('./lib/api').KnowledgeEntry) {
  syncLocalEntry(entry)
}
/** 发布 / 撤回成功：卡片流 / 目录树 / 右栏一致刷新 */
function onStatusChanged(entry: import('./lib/api').KnowledgeEntry) {
  syncLocalEntry(entry)
  dataKey.value++
  docTreeKey.value++
  showAppToast(entry.status === 'published' ? '已发布 · 游客现已可见' : '已撤回 · 仅站主可见')
}
function onDeleted() {
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
  docTreeKey.value++
  dataKey.value++
}
function onExitEdit(to: 'read' | 'list') {
  if (to === 'read' && article.value) {
    detailMode.value = 'read'
    return
  }
  article.value = null
  detailMode.value = 'list'
  clearWsConflict()
}

/** 阅读态快捷「发布」（仅站主；草稿徽标处的按钮） */
async function quickPublish(entry: import('./lib/api').KnowledgeEntry) {
  try {
    onLocalWrite()
    const r = await api<{ entry: import('./lib/api').KnowledgeEntry }>(
      `/api/knowledge/entries/${entry.id}`,
      { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ status: 'published' }) },
    )
    syncLocalEntry(r.entry)
    dataKey.value++
    docTreeKey.value++
    showAppToast('已发布 · 游客现已可见')
  } catch (e: any) {
    showAppToast(`发布失败：${e?.message ?? e}`)
  }
}
// 批量导入文档（站主）：入口 + 导入完成后刷新列表/分类/目录树/右栏
function openImport() {
  if (user.value?.role !== 'admin') {
    alert('仅站主可导入文档')
    return
  }
  importOpen.value = true
}
function onDocsImported(payload?: { count?: number; parentId?: string }) {
  loadCategories()
  // 指定了父文档：目录树重挂载后自动展开并定位到该父文档
  importTargetParentId.value = payload?.parentId ?? ''
  docTreeKey.value++
  dataKey.value++
}
function submitGlobalSearch() {
  if (!globalQ.value.trim()) return
  tab.value = HOME_TAB
}

// 热更新
const updateInfo = ref<UpdateInfo | null>(null)
const updateAvailable = ref(false)
const updateOpen = ref(false)

async function checkUpdate() {
  const info = await fetchUpdateManifest()
  updateInfo.value = info
  if (hasUpdateFn(info)) {
    updateAvailable.value = true
  }
}

// 主动推送：定期轮询 + 窗口聚焦/可见时检查（应用打开期间无需重启即可发现更新）
let updateTimer: number | undefined
function scheduleUpdateChecks() {
  updateTimer = window.setInterval(() => checkUpdate(), 10 * 60 * 1000)
  document.addEventListener('visibilitychange', onVisibilityChanged)
  window.addEventListener('focus', checkUpdate)
}
function onVisibilityChanged() {
  if (document.visibilityState === 'visible') checkUpdate()
}

function onUpdateApplied() {
  updateAvailable.value = false
}

function onRequestUpdate(info: UpdateInfo) {
  updateInfo.value = info
  updateOpen.value = true
  settingsOpen.value = false
}

function dismissUpdate() {
  updateAvailable.value = false
}

// 暗色模式（默认跟随系统，可手动切换）
const theme = ref<'light' | 'dark'>(
  (localStorage.getItem('ikit-theme') as 'light' | 'dark') ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
)

function applyTheme() {
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('ikit-theme', theme.value)
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  applyTheme()
}

applyTheme()

provide('events', events)
provide('canWrite', computed(() => !!user.value))
provide('userRole', computed(() => user.value?.role ?? 'guest'))
provide('username', computed(() => user.value?.username ?? ''))
provide('currentUser', user)
// 编辑器主题跟随门户（VditorEditor 内 watch 切换编辑器/内容/代码主题）
provide('theme', theme)
// 插件管理页（PluginSettings.vue）↔ 顶部 nav / 移动 tabbar 的排序联动契约
provide('pluginOrderSync', { preview: previewPluginOrder, refresh: refreshPlugins })

let socket: ReturnType<typeof createSocket> | null = null

onMounted(() => {
  socket = createSocket(
    (msg) => {
      if (msg.type === 'connected' || msg.type === 'pong') return
      events.value.unshift(msg)
      if (events.value.length > 100) events.value.length = 100
      // AC-24 多端联动：他端改动当前文章 → 顶部提示条（编辑态不覆盖输入；阅读态由用户点「重新载入」）
      if (msg.type === 'knowledge:changed') onKnowledgeChanged(msg)
    },
    (status) => {
      wsStatus.value = status
    },
  )
  checkUpdate()
  authToken = getToken() ?? ''
  currentUser()
    .then((u) => {
      user.value = u
      role.value = u ? (u.role as PluginRole) : 'guest'
      ensureNode()
    })
    .catch(() => {
      user.value = null
      role.value = 'guest'
    })
    .finally(() => refreshPlugins())
  loadCategories()
  scheduleUpdateChecks()
  window.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onKeyShortcut)
})

function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (!t.closest('.avatar-wrap')) avatarOpen.value = false
}

/** 焦点是否在输入控件内（用于 `N` / `/` 等裸键快捷键不抢输入） */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

function onKeyShortcut(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchInput.value?.focus()
    return
  }
  // Ctrl/Cmd+S：编辑态 → 立即保存（拦截浏览器保存对话框）；非编辑态不拦截
  if (mod && e.key.toLowerCase() === 's') {
    if (inEditMode.value) {
      e.preventDefault()
      void flushCurrent()
    }
    return
  }
  if (e.key === 'Escape') {
    adminOpen.value = false
    avatarOpen.value = false
    return
  }
  if (isTypingTarget(e.target)) return
  // `/` 聚焦搜索（README 既有描述，本期补齐）
  if (e.key === '/' && !mod && !e.altKey) {
    e.preventDefault()
    searchInput.value?.focus()
    return
  }
  // `N` 新建文章（仅站主；编辑态内不响应，避免误触丢输入）
  if (
    e.key.toLowerCase() === 'n' &&
    !mod &&
    !e.altKey &&
    user.value?.role === 'admin' &&
    !inEditMode.value
  ) {
    e.preventDefault()
    void enterNew('')
  }
}

onUnmounted(() => {
  socket?.close()
  wsGate.dispose()
  stopDesktopNode()
  if (updateTimer !== undefined) clearInterval(updateTimer)
  if (appToastTimer) clearTimeout(appToastTimer)
  document.removeEventListener('visibilitychange', onVisibilityChanged)
  window.removeEventListener('focus', checkUpdate)
  window.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onKeyShortcut)
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <!-- 窄屏侧栏开关（<1200px 显示；置于最左） -->
      <div class="side-toggle">
        <button class="side-btn" title="目录导航" @click="sideLeftOpen = !sideLeftOpen">☰</button>
        <button class="side-btn" title="侧边栏" @click="sideRightOpen = !sideRightOpen">◫</button>
      </div>
      <div class="brand">
        <span class="brand-logo">🧠</span>
        <span class="brand-name">i-kit</span>
        <span class="brand-sub">知识门户</span>
      </div>
      <div class="global-search">
        <input ref="searchInput" v-model="globalQ" placeholder="搜索（Ctrl + K）" @keydown.enter="submitGlobalSearch" />
      </div>
      <nav>
        <button :class="{ active: tab === HOME_TAB }" @click="goHome">首页</button>
        <!-- 前台功能插件（原左栏，移至顶部） -->
        <button
          v-for="p in features"
          :key="p.name"
          :class="{ active: tab === p.name }"
          @click="tab = p.name"
        >
          {{ p.title }}
        </button>
      </nav>
      <span class="ws" :class="wsStatus">
        <i class="dot" />
        {{
          wsStatus === 'open' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '已断开'
        }}
      </span>
      <!-- 窄屏侧栏开关（<1200px 显示） -->
      <!-- 头像：点击弹登录框（未登录）或用户菜单（已登录） -->
      <button class="settings-btn" title="设置" @click="settingsOpen = true">⚙️</button>
      <div v-if="user" class="avatar-wrap" @click.stop>
        <button class="avatar-btn" title="账号" @click="avatarOpen = !avatarOpen">
          <span class="avatar-avatar">{{ user.username.slice(0, 1).toUpperCase() }}</span>
        </button>
        <div v-if="avatarOpen" class="avatar-dropdown" @click.stop>
          <div class="ad-name">{{ user.username }}</div>
          <div class="ad-role">{{ user.role === 'admin' ? '站主' : '用户' }}</div>
          <button class="ad-item" @click="profileOpen = true; avatarOpen = false">✏️ 编辑资料</button>
          <button class="ad-item" @click="settingsOpen = true; avatarOpen = false">⚙️ 设置</button>
          <button class="ad-item" @click="doLogout">退出登录</button>
        </div>
      </div>
      <button v-else class="avatar-btn" title="登录" @click="showAuth = true">
        <span class="avatar-avatar guest">?</span>
      </button>
      <button class="theme-toggle" :title="theme === 'light' ? '切换暗色' : '切换亮色'" @click="toggleTheme">
        {{ theme === 'light' ? '🌙' : '☀️' }}
      </button>
    </header>

    <!-- 热更新提示 -->
    <div v-if="updateAvailable" class="update-banner">
      <span class="ub-icon">🔄</span>
      <span class="ub-text">
        发现新版本
        <b>v{{ updateInfo?.latest }}</b>
        (当前 v{{ updateInfo?.currentVersion }})
      </span>
      <button class="ub-btn" @click="updateOpen = true">更新</button>
      <button class="ub-dismiss" title="稍后" @click="dismissUpdate">×</button>
    </div>

    <!-- 轻提示（发布 / 撤回 / 保存失败等；非弹窗） -->
    <div v-if="appToast" class="app-toast">{{ appToast }}</div>

    <!-- 多端冲突提示条（AC-24；非弹窗黄条，**仅站主**）：编辑态只告知、绝不覆盖输入；
         阅读态由用户显式点「重新载入」替换内容；他端删除（remove）时给出「返回列表」 -->
    <div v-if="wsConflict" class="app-banner" role="status">
      <span class="ub-icon">⚠️</span>
      <span class="ub-text">{{ wsConflictText }}</span>
      <!-- 他端删除：阅读态「返回列表」；编辑/新建态「返回列表 / 继续编辑」 -->
      <template v-if="wsConflict.kind === 'remove'">
        <button class="ub-btn" @click="wsBackToList">返回列表</button>
        <button v-if="inEditMode" class="ub-dismiss" title="继续编辑" @click="dismissWsConflict">继续编辑</button>
      </template>
      <!-- 他端修改：编辑态只提示（无「重新载入」→ 无 WS→编辑器回写路径）；阅读态可显式重新载入 -->
      <template v-else-if="inEditMode">
        <button class="ub-btn" @click="dismissWsConflict">继续编辑</button>
      </template>
      <template v-else>
        <button class="ub-btn" @click="reloadLatest">重新载入</button>
        <button class="ub-dismiss" title="稍后" @click="dismissWsConflict">×</button>
      </template>
    </div>

    <div class="portal" :class="{ 'side-open-left': sideLeftOpen, 'side-open-right': sideRightOpen }">
      <!-- 左侧导航（桌面） -->
      <aside class="portal-left">
        <div class="pl-moto">以不折腾为目标的折腾</div>
        <nav class="pl-nav">
          <button :class="{ active: tab === HOME_TAB && !article }" @click="goHome">
            <span class="pl-ico">🏠</span> 首页
          </button>
          <button :class="{ active: tab === 'archive' }" @click="tab = 'archive'">
            <span class="pl-ico">📥</span> 归档
          </button>
          <button :class="{ active: tab === 'trash' }" @click="tab = 'trash'">
            <span class="pl-ico">🗑</span> 回收站
          </button>
          <button v-if="user?.role === 'admin'" @click="enterNew('')">
            <span class="pl-ico">✎</span> 新建文章
          </button>
          <button v-if="user?.role === 'admin'" @click="openImport">
            <span class="pl-ico">📥</span> 导入文档
          </button>
          <div class="pl-group pl-dir-group">
            <span class="pl-group-title">目录</span>
            <div class="pl-doc-tree">
              <DocTree
                :key="docTreeKey"
                :category="filterCat"
                :tag="filterTag"
                :expand-ids="importTargetParentId ? [importTargetParentId] : []"
                @open="onOpenEntry"
                @edit="enterEdit"
                @create-child="enterNew"
              />
            </div>
          </div>
        </nav>
      </aside>

      <!-- 主内容区 -->
      <main class="portal-main">
        <ArticleDetail
          v-if="tab === HOME_TAB && article && detailMode === 'read'"
          :entry="article"
          @back="backToList"
          @edit="enterEdit"
          @tag="onSelectTag"
          @publish="quickPublish"
        />
        <ArticleEditView
          v-else-if="tab === HOME_TAB && inEditMode"
          ref="editViewRef"
          :key="editKey"
          :entry="article"
          :parent-id="draftParentId"
          :categories="categoryPaths"
          @created="onDraftCreated"
          @saved="onSaved"
          @status="onStatusChanged"
          @writing="onLocalWrite"
          @exit="onExitEdit"
          @deleted="onDeleted"
        />
        <ContentCardFeed
          v-else-if="tab === HOME_TAB"
          :key="dataKey"
          :query="globalQ"
          :category="filterCat"
          :tag="filterTag"
          :categories="categoryPaths"
          @open="onOpenEntry"
          @categories="loadCategories"
          @clear="onClearFilter"
        />
        <SystemPanel v-else-if="tab === 'system' && user?.role === 'admin'" />
        <AgentPanel v-else-if="tab === 'agent'" />
        <ArchiveView v-else-if="tab === 'archive'" @open="onOpenEntry" />
        <TrashView v-else-if="tab === 'trash'" @open="onOpenEntry" />
        <StorePluginPanel v-else-if="isStorePlugin(tab)" :panel="tab" />
        <PluginSettings v-else-if="tab === 'manager' && user?.role === 'admin'" />
        <PluginStore v-else-if="tab === 'store' && user?.role === 'admin'" />
        <UserManager v-else-if="tab === 'users' && user?.role === 'admin'" />
        <div v-else class="empty-tab">该插件已隐藏或未启用</div>
      </main>

      <!-- 右侧 widget 栏（桌面） -->
      <aside class="portal-right">
        <PortalRight :key="dataKey" @open="onOpenEntry" @tag="onFilterTag" @category="onFilterCategory" />
      </aside>
    </div>

    <!-- 底部栏：与左右侧栏齐宽，固定底部；站主管理移入此处 -->
    <footer class="bottom-bar">
      <span class="bb-left">🧠 i-kit 知识门户</span>
      <nav v-if="user?.role === 'admin'" class="bb-admin">
        <button
          v-for="a in ADMIN_TABS"
          :key="a.key"
          :class="{ active: tab === a.key }"
          @click="chooseAdmin(a.key)"
        >
          <span class="admin-top-ico">{{ a.icon }}</span> {{ a.label }}
        </button>
      </nav>
      <span class="bb-right">© 2026 · 三端同源（Web / 桌面 / 移动）</span>
    </footer>

    <!-- 窄屏侧栏抽屉遮罩 -->
    <div
      v-if="sideLeftOpen || sideRightOpen"
      class="side-backdrop"
      @click="sideLeftOpen = false; sideRightOpen = false"
    ></div>

    <!-- 登录/注册/找回 -->
    <div v-if="showAuth" class="auth-overlay" @click.self="showAuth = false">
      <AuthPanel @authed="onAuthed" />
      <button class="auth-close" title="关闭" @click="showAuth = false">×</button>
    </div>

    <!-- 文章编辑弹窗已移除：编辑/新建都在详情页内就地完成（完善⑦） -->

    <!-- 批量导入文档（仅站主，文件 / 文件夹） -->
    <ImportDocsDialog
      v-if="importOpen"
      @close="importOpen = false"
      @imported="onDocsImported"
    />

    <!-- 设置（检查更新 / 关于 / 帮助） -->
    <SettingsPanel
      v-if="settingsOpen"
      @close="settingsOpen = false"
      @request-update="onRequestUpdate"
    />

    <!-- 编辑资料（改用户名 / 密码） -->
    <UserProfile v-if="profileOpen" @updated="onProfileUpdated" @close="profileOpen = false" />

    <!-- 软件更新（确认 → 进度 → 应用 / 硬更新安装） -->
    <UpdateDialog
      v-if="updateOpen && updateInfo"
      :info="updateInfo"
      @close="updateOpen = false"
      @applied="onUpdateApplied"
    />

    <!-- 移动端底部 Tab Bar -->
    <nav class="bottom-tabbar">
      <!-- 首页（知识卡片流） -->
      <button :class="{ active: tab === HOME_TAB }" @click="goHome">
        <span class="tab-icon">🏠</span>
        <span class="tab-label">首页</span>
      </button>
      <!-- 默认功能 + 前台功能插件 -->
      <button
        v-for="p in features"
        :key="p.name"
        :class="{ active: tab === p.name }"
        @click="tab = p.name"
      >
        <span class="tab-icon">{{ p.panel === 'agent' ? '🤖' : p.panel === 'knowledge' ? '📚' : '🧩' }}</span>
        <span class="tab-label">{{ p.title }}</span>
      </button>
      <!-- 设置（桌面/移动通用） -->
      <button class="settings-tab" @click="settingsOpen = true">
        <span class="tab-icon">🔧</span>
        <span class="tab-label">设置</span>
      </button>
      <!-- 站主管理：与功能插件分开的独立入口 -->
      <button
        v-if="user?.role === 'admin'"
        :class="{ active: isAdminTab(tab), 'admin-tab-active': isAdminTab(tab) }"
        class="admin-tab"
        @click.stop="toggleMobileAdmin"
      >
        <span class="tab-icon">⚙️</span>
        <span class="tab-label">管理</span>
      </button>
    </nav>

    <!-- 移动端站主管理选择面板 -->
    <div v-if="adminOpen && user?.role === 'admin'" class="mobile-admin-sheet" @click.stop="adminOpen = false">
      <button v-for="a in ADMIN_TABS" :key="a.key" :class="{ active: tab === a.key }" @click="chooseAdmin(a.key)">
        <span>{{ a.icon }}</span> {{ a.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 16px 0;
  padding: 10px 14px;
  background: var(--primary-soft);
  border: 1px solid var(--primary);
  border-radius: 10px;
  color: var(--primary-dark);
  font-size: 13px;
  animation: ub-in 0.3s ease;
}
@keyframes ub-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}
.ub-icon { font-size: 16px; }
.ub-text { flex: 1; }
.ub-btn {
  border: none;
  background: var(--primary);
  color: #fff;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.ub-btn:disabled { opacity: 0.6; cursor: default; }
.ub-dismiss {
  border: none;
  background: transparent;
  color: var(--primary-dark);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
[data-theme='dark'] .update-banner {
  color: var(--primary-dark);
}

.auth-overlay {
  position: fixed; inset: 0; z-index: 500;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.auth-close {
  position: absolute; top: 8px; right: 20px;
  border: none; background: transparent; color: #fff;
  font-size: 28px; cursor: pointer; line-height: 1;
}
.empty-tab {
  padding: 40px;
  text-align: center;
  color: var(--muted);
}
/* 全局轻提示（发布/撤回等反馈） */
.app-toast {
  position: fixed;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 600;
  padding: 8px 18px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary-dark);
  border: 1px solid var(--primary);
  font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
/* 多端冲突提示条（AC-24）：与 update-banner 同构，黄色 warn 系，非弹窗 */
.app-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 16px 0;
  padding: 10px 14px;
  background: var(--warn-soft, #fef3c7);
  border: 1px solid var(--warn, #f59e0b);
  border-radius: 10px;
  color: var(--warn, #b45309);
  font-size: 13px;
}
.app-banner .ub-text { flex: 1; }
.app-banner .ub-btn { background: var(--warn, #f59e0b); }
.app-banner .ub-dismiss { color: var(--warn, #b45309); }

.settings-btn {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}
.settings-btn:hover { background: var(--primary-soft); }
/* 窄屏侧栏开关（默认隐藏，<1200px 显示） */
.side-toggle { display: none; align-items: center; gap: 6px; flex: 0 0 auto; }
.side-btn {
  border: 1px solid var(--border); background: var(--panel); border-radius: 8px;
  padding: 6px 10px; cursor: pointer; font-size: 15px; line-height: 1;
}
.side-btn:hover { background: var(--primary-soft); }
.side-backdrop {
  display: none; position: fixed; inset: 60px 0 0; z-index: 385;
  background: rgba(15, 23, 42, 0.35);
}
.theme-toggle {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

/* 移动端站主管理表（默认隐藏，仅小屏显示） */
.mobile-admin-sheet {
  display: none;
}
.bottom-tabbar button.admin-tab {
  color: var(--primary-dark);
}
.bottom-tabbar button.admin-tab.admin-tab-active {
  background: var(--primary-soft);
  color: var(--primary-dark);
  font-weight: 600;
}

.bottom-tabbar {
  display: none;
}

/* 顶栏：品牌 + 全局搜索 + 头像 */
/* 参考站顶栏为半透明毛玻璃面板 */
.topbar {
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  box-shadow: 0 1px 0 var(--border);
}
@supports not (background: color-mix(in srgb, red, transparent)) {
  .topbar { background: var(--panel); }
}
[data-theme='dark'] .topbar {
  background: color-mix(in srgb, var(--panel) 72%, transparent);
}
.brand { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; white-space: nowrap; }
.brand-logo { font-size: 20px; }
.brand-name { font-size: 17px; font-weight: 700; }
.brand-sub { font-size: 11px; color: var(--muted); padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; }
.global-search { flex: 1 1 auto; min-width: 80px; }
.global-search input {
  width: 100%;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.topbar nav { flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.topbar nav::-webkit-scrollbar { display: none; }
.topbar nav button { flex: 0 0 auto; white-space: nowrap; }
.avatar-wrap { position: relative; }
.avatar-btn { border: none; background: transparent; cursor: pointer; padding: 0; display: inline-flex; }
.avatar-avatar {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--primary); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 600;
}
.avatar-avatar.guest { background: var(--muted); }
.avatar-dropdown {
  position: absolute; top: calc(100% + 8px); right: 0; min-width: 160px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14); padding: 6px; z-index: 40;
}
.ad-name { font-weight: 600; font-size: 14px; padding: 8px 10px 2px; }
.ad-role { font-size: 12px; color: var(--muted); padding: 0 10px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.ad-item {
  display: block; width: 100%; text-align: left; padding: 8px 10px;
  border: none; background: transparent; border-radius: 8px;
  color: var(--text); font-size: 13px; cursor: pointer; font-family: inherit;
}
.ad-item:hover { background: var(--primary-soft); color: var(--danger); }
[data-theme='dark'] .avatar-dropdown { box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); }

/* 三栏门户：中间内容栏固定尺寸，不随内容切换而改变宽度（参考站比例：左 280 / 中 自适应 / 右 300） */
.portal {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) 300px;
  gap: 24px;
  padding: 16px 24px 52px; /* 底部留出固定底栏高度，grid 行延至底栏顶部 */
  align-items: start;
  width: 100%;
  max-width: 1640px;
  margin: 0 auto;
}

/* 底部栏：与左右侧栏对齐、固定在底部 */
.bottom-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  margin: 0 auto;
  width: calc(100% - 48px);
  max-width: 1592px;
  height: 52px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  font-size: 12px;
  color: var(--muted);
  z-index: 300;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.05);
}
.bb-left { font-weight: 600; color: var(--text); }
.bb-admin { display: flex; align-items: center; gap: 4px; }
.bb-admin button {
  border: none; background: transparent; color: var(--muted);
  border-radius: 8px; padding: 6px 10px; font-size: 12px;
  font-family: inherit; cursor: pointer; white-space: nowrap;
}
.bb-admin button:hover { background: var(--primary-soft); color: var(--primary-dark); }
.bb-admin button.active { background: var(--primary-soft); color: var(--primary-dark); font-weight: 600; }
.admin-top-ico { margin-right: 3px; }
[data-theme='dark'] .bottom-bar { box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4); }
.portal-left {
  position: sticky; top: 76px;
  height: calc(100vh - 128px); /* 底部与底部栏顶部对齐 */
  max-height: calc(100vh - 128px);
  overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  display: flex; flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px 10px;
}
[data-theme='dark'] .portal-left { background: var(--panel); }
.portal-right {
  position: sticky; top: 76px;
  height: calc(100vh - 128px);
  max-height: calc(100vh - 128px);
  overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}
.portal-left::-webkit-scrollbar, .portal-right::-webkit-scrollbar,
.pl-doc-tree::-webkit-scrollbar { width: 6px; }
.portal-left::-webkit-scrollbar-thumb, .portal-right::-webkit-scrollbar-thumb,
.pl-doc-tree::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.portal-left::-webkit-scrollbar-track, .portal-right::-webkit-scrollbar-track,
.pl-doc-tree::-webkit-scrollbar-track { background: transparent; }
.portal-main {
  min-width: 0;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 20px;
  min-height: calc(100vh - 140px);
}
[data-theme='dark'] .portal-main { background: var(--panel); }
.portal-main > * { width: 100%; min-width: 0; }
.pl-moto {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 12px;
  padding: 10px 12px;
  background: var(--primary-soft);
  border-radius: 10px;
  font-style: italic;
}
.pl-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; min-height: 0; }
.pl-dir-group { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.pl-doc-tree { flex: 1 1 auto; min-height: 80px; overflow-y: auto; padding: 0 4px; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.pl-nav button {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px;
  border: none; background: transparent; border-radius: 8px;
  color: var(--text); font-size: 13px; font-family: inherit; cursor: pointer; text-align: left;
  position: relative;
}
.pl-nav button:hover { background: var(--primary-soft); }
.pl-nav button.active {
  background: var(--primary-soft);
  color: var(--primary-dark);
  font-weight: 600;
}
.pl-nav button.active::before {
  content: '';
  position: absolute;
  left: 0; top: 8px; bottom: 8px;
  width: 3px; border-radius: 2px;
  background: var(--primary);
}
.pl-group { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
.pl-group-title { font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px; padding-left: 10px; }
.pl-ico { width: 20px; text-align: center; }

/* 窄屏（<1200px）：单栏 + 左右侧栏收为抽屉，顶栏提供 ☰/◫ 开关 */
@media (max-width: 1199px) {
  .portal { grid-template-columns: minmax(0, 1fr); }
  .side-toggle { display: flex; }
  .brand-sub { display: none; }
  .portal-left, .portal-right {
    position: fixed;
    top: 60px;
    bottom: 0;
    height: auto;
    max-height: none;
    width: min(320px, 84vw);
    z-index: 410;
    border-radius: 0;
    transition: transform 0.25s ease;
  }
  .portal-left { left: 0; transform: translateX(-105%); }
  .portal-right { right: 0; transform: translateX(105%); }
  .portal.side-open-left .portal-left { transform: translateX(0); box-shadow: 8px 0 24px rgba(0,0,0,.15); }
  .portal.side-open-right .portal-right { transform: translateX(0); box-shadow: -8px 0 24px rgba(0,0,0,.15); }
  .side-backdrop { display: block; }
}

@media (max-width: 768px) {
  .topbar nav {
    display: none;
  }
  .topbar { gap: 10px; padding: 0 12px; }
  .ws { display: none; }
  .bottom-bar { display: none; }
  .bottom-tabbar {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    z-index: 400;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .bottom-tabbar button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
  }
  .bottom-tabbar button.active {
    color: var(--primary-dark);
    font-weight: 600;
  }
  .tab-icon {
    font-size: 18px;
    line-height: 1;
  }
  .portal { grid-template-columns: 1fr; padding: 12px; }
  .brand-sub { display: none; }
  .global-search { flex: 1; }
  .portal-main, main {
    padding-bottom: 72px;
  }
  .mobile-admin-sheet {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: fixed;
    left: 8px;
    right: 8px;
    bottom: 64px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12), 0 12px 32px rgba(0, 0, 0, 0.12);
    padding: 6px;
    z-index: 450;
  }
  .mobile-admin-sheet button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 12px;
    border: none;
    background: transparent;
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .mobile-admin-sheet button:hover {
    background: var(--primary-soft);
  }
  .mobile-admin-sheet button.active {
    background: var(--primary-soft);
    color: var(--primary-dark);
    font-weight: 600;
  }
}
</style>
