<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject, type Ref } from 'vue'
import { api, type KnowledgeEntry, type EventItem, type CategoryNode } from '../lib/api'
import { renderMarkdown, type TocItem } from '../lib/markdown'
import CategoryTree from './CategoryTree.vue'

const lastEvent = inject<Ref<EventItem | null>>('lastEvent', ref(null))

const entries = ref<KnowledgeEntry[]>([])
const categories = ref<CategoryNode[]>([])
const searchQ = ref('')
const searchResults = ref<Array<{ entry: KnowledgeEntry; score: number }>>([])
const activeCategory = ref('')
const selectedId = ref(localStorage.getItem('ikit-kb-selected') ?? '')
const loading = ref(false)
const sortOption = ref<'updated' | 'title' | 'created'>('updated')
const statusFilter = ref<'all' | 'draft' | 'published' | 'archived'>('all')
const timeFilter = ref<'all' | '7d' | '30d' | '90d'>('all')
const view = ref<'list' | 'trash'>('list')
const trashEntries = ref<KnowledgeEntry[]>([])
const error = ref('')
const notice = ref('')

// 编辑状态
const editing = ref(false)
const form = ref({ title: '', content: '', tags: '', category: '' })

// 导入
const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)

// 添加分类
const showAddCategory = ref(false)
const newCategory = ref('')

// 响应式抽屉（移动端/平板）
const showSidebar = ref(false)
const showRight = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

// 最近访问
const recentIds = ref<string[]>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem('ikit-kb-recent') ?? '[]')
    } catch {
      return []
    }
  })(),
)

function recordRecent(id: string) {
  const next = [id, ...recentIds.value.filter((x) => x !== id)].slice(0, 10)
  recentIds.value = next
  localStorage.setItem('ikit-kb-recent', JSON.stringify(next))
}

const recentEntries = computed(() =>
  recentIds.value
    .map((id) => entries.value.find((e) => e.id === id))
    .filter((e): e is KnowledgeEntry => !!e),
)

let searchTimer: ReturnType<typeof setTimeout> | null = null

async function load() {
  loading.value = true
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/entries')
    entries.value = r.entries
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadCategories() {
  try {
    const r = await api<{ categories: CategoryNode[] }>('/api/knowledge/categories')
    categories.value = r.categories
  } catch (e: any) {
    error.value = e.message
  }
}

async function doSearch() {
  if (!searchQ.value.trim()) {
    searchResults.value = []
    return
  }
  try {
    const r = await api<{ results: Array<{ entry: KnowledgeEntry; score: number }> }>(
      `/api/knowledge/search?q=${encodeURIComponent(searchQ.value)}`,
    )
    searchResults.value = r.results
  } catch (e: any) {
    error.value = e.message
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(doSearch, 300)
}

const tags = computed(() => {
  const map = new Map<string, number>()
  for (const e of entries.value) {
    for (const t of e.tags) map.set(t, (map.get(t) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
})

const totalWords = computed(() =>
  entries.value.reduce((sum, e) => sum + (e.content?.length ?? 0), 0),
)

const categoryPaths = computed(() => {
  const paths: string[] = []
  const walk = (nodes: CategoryNode[]) => {
    for (const n of nodes) {
      paths.push(n.path)
      walk(n.children)
    }
  }
  walk(categories.value)
  return paths
})

const display = computed(() => {
  const searching = !!searchQ.value.trim()
  let base = searching ? searchResults.value.map((r) => r.entry) : entries.value
  if (activeCategory.value) {
    base = base.filter(
      (e) =>
        e.category &&
        (e.category === activeCategory.value || e.category.startsWith(`${activeCategory.value}/`)),
    )
  }
  if (statusFilter.value !== 'all') {
    base = base.filter((e) => (e.status ?? 'published') === statusFilter.value)
  }
  if (timeFilter.value !== 'all') {
    const days = timeFilter.value === '7d' ? 7 : timeFilter.value === '30d' ? 30 : 90
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    base = base.filter((e) => new Date(e.updatedAt).getTime() >= cutoff)
  }
  // 置顶优先
  return [...base].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    if (searching) return 0
    if (sortOption.value === 'title') return a.title.localeCompare(b.title)
    if (sortOption.value === 'created') return b.createdAt.localeCompare(a.createdAt)
    return b.updatedAt.localeCompare(a.updatedAt)
  })
})

const selected = computed(() => display.value.find((e) => e.id === selectedId.value) ?? null)

const rendered = computed(() =>
  selected.value && !editing.value
    ? renderMarkdown(selected.value.content)
    : { html: '', toc: [] as TocItem[] },
)

// 编辑实时预览
const previewHtml = computed(() => renderMarkdown(form.value.content).html)

// 搜索高亮
function highlight(text: string, q: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (!q.trim()) return escaped
  const qEsc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped.replace(new RegExp(`(${qEsc})`, 'gi'), '<mark>$1</mark>')
}

watch(selectedId, (v) => {
  localStorage.setItem('ikit-kb-selected', v)
})

watch(display, (list) => {
  if (!list.some((e) => e.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? ''
  }
})

function closeDrawers() {
  showSidebar.value = false
  showRight.value = false
}

function select(id: string) {
  selectedId.value = id
  editing.value = false
  showRight.value = false
  recordRecent(id)
}

function selectCategory(path: string) {
  activeCategory.value = activeCategory.value === path ? '' : path
  showSidebar.value = false
}

function openCreate() {
  editing.value = true
  selectedId.value = ''
  form.value = loadDraft() ?? { title: '', content: '', tags: '', category: activeCategory.value }
}

function openEdit() {
  if (!selected.value) return
  editing.value = true
  form.value = {
    title: selected.value.title,
    content: selected.value.content,
    tags: selected.value.tags.join(', '),
    category: selected.value.category ?? '',
  }
}

function cancelEdit() {
  editing.value = false
}

// ---- 草稿自动保存 ----
const DRAFT_KEY = 'ikit-kb-draft'

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(form.value))
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY)
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')
    if (d && (d.title || d.content)) return d
  } catch {
    /* ignore */
  }
  return null
}

let draftTimer: ReturnType<typeof setTimeout> | null = null
watch(
  form,
  () => {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(saveDraft, 500)
  },
  { deep: true },
)

async function save() {
  error.value = ''
  const payload = {
    title: form.value.title,
    content: form.value.content,
    tags: form.value.tags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    category: form.value.category.trim() || undefined,
  }
  try {
    if (selectedId.value && selected.value) {
      await api(`/api/knowledge/entries/${selectedId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      const r = await api<{ entry: KnowledgeEntry }>('/api/knowledge/entries', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      selectedId.value = r.entry.id
    }
    editing.value = false
    clearDraft()
    await load()
    await loadCategories()
    if (searchQ.value.trim()) await doSearch()
    notice.value = '已保存'
  } catch (e: any) {
    error.value = e.message
  }
}

async function remove() {
  if (!selected.value) return
  if (!confirm(`确认删除「${selected.value.title}」？`)) return
  await api(`/api/knowledge/entries/${selected.value.id}`, { method: 'DELETE' })
  selectedId.value = ''
  await load()
  await loadCategories()
}

async function togglePin() {
  if (!selected.value) return
  await api(`/api/knowledge/entries/${selected.value.id}/toggle-pin`, { method: 'POST' })
  await load()
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
}

// 面包屑（分类路径拆分）
const breadcrumbParts = computed(() => selected.value?.category?.split('/').filter(Boolean) ?? [])
const breadcrumbPaths = computed(() => {
  const paths: string[] = []
  let cur = ''
  for (const p of breadcrumbParts.value) {
    cur = cur ? `${cur}/${p}` : p
    paths.push(cur)
  }
  return paths
})

async function changeStatus(status: 'draft' | 'published' | 'archived') {
  if (!selected.value) return
  await api(`/api/knowledge/entries/${selected.value.id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  })
  await load()
  if (searchQ.value.trim()) await doSearch()
  notice.value = `状态已改为「${STATUS_LABEL[status]}」`
}

// 图片放大预览
const lightboxSrc = ref('')

function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'IMG') {
    lightboxSrc.value = target.getAttribute('src') ?? ''
  }
}

function closeLightbox() {
  lightboxSrc.value = ''
}

// 版本历史
const showHistory = ref(false)

async function restoreVersion(version: number) {
  if (!selected.value) return
  if (!confirm(`回滚到版本 v${version}？当前内容会保存为新版本。`)) return
  await api(`/api/knowledge/entries/${selected.value.id}/restore`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
  await load()
  if (searchQ.value.trim()) await doSearch()
  notice.value = `已回滚到版本 v${version}`
}

// AI 摘要
const summarizing = ref(false)

async function generateSummary() {
  if (!selected.value || summarizing.value) return
  summarizing.value = true
  try {
    await api(`/api/knowledge/entries/${selected.value.id}/summary`, { method: 'POST' })
    await load()
    if (searchQ.value.trim()) await doSearch()
    notice.value = '摘要已生成'
  } catch (e: any) {
    error.value = e.message
  } finally {
    summarizing.value = false
  }
}

async function rateEntry(rating: number) {
  if (!selected.value) return
  await api(`/api/knowledge/entries/${selected.value.id}/rate`, {
    method: 'POST',
    body: JSON.stringify({ rating }),
  })
  await load()
  if (searchQ.value.trim()) await doSearch()
}

async function likeEntry() {
  if (!selected.value) return
  await api(`/api/knowledge/entries/${selected.value.id}/like`, { method: 'POST' })
  await load()
  if (searchQ.value.trim()) await doSearch()
}

async function shareEntry() {
  if (!selected.value) return
  const r = await api<{ entry: KnowledgeEntry }>(
    `/api/knowledge/entries/${selected.value.id}/share`,
    { method: 'POST' },
  )
  const link = `${location.origin}/api/share/${r.entry.shareToken}`
  try {
    await navigator.clipboard.writeText(link)
    notice.value = '分享链接已复制到剪贴板'
  } catch {
    prompt('分享链接（复制）：', link)
  }
  await load()
}

function exportEntry() {
  if (!selected.value) return
  const content = `# ${selected.value.title}\n\n${selected.value.content}`
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${selected.value.title.replace(/[\\/:*?"<>|]/g, '_')}.md`
  a.click()
  URL.revokeObjectURL(url)
}

// ---- 回收站 ----
async function loadTrash() {
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/trash')
    trashEntries.value = r.entries
  } catch (e: any) {
    error.value = e.message
  }
}

function showTrash() {
  view.value = 'trash'
  loadTrash()
}

function showList() {
  view.value = 'list'
}

async function restoreEntry(id: string) {
  await api(`/api/knowledge/trash/${id}/restore`, { method: 'POST' })
  loadTrash()
  load()
  loadCategories()
  notice.value = '已恢复'
}

async function purgeEntry(id: string) {
  if (!confirm('彻底删除后不可恢复，确认？')) return
  await api(`/api/knowledge/trash/${id}`, { method: 'DELETE' })
  loadTrash()
}

async function emptyTrash() {
  if (!confirm('清空回收站后不可恢复，确认？')) return
  await api('/api/knowledge/trash', { method: 'DELETE' })
  loadTrash()
}

// ---- 分类 ----
async function addCategory() {
  const path = newCategory.value.trim()
  if (!path) return
  try {
    await api('/api/knowledge/categories', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
    newCategory.value = ''
    showAddCategory.value = false
    await loadCategories()
    notice.value = '分类已添加'
  } catch (e: any) {
    error.value = e.message
  }
}

async function removeCategory(path: string) {
  if (!confirm(`删除分类「${path}」及其子分类？`)) return
  await api(`/api/knowledge/categories?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (activeCategory.value === path || activeCategory.value.startsWith(`${path}/`)) {
    activeCategory.value = ''
  }
  await loadCategories()
  await load()
}

async function renameCategory(path: string) {
  const newPath = prompt(`重命名分类「${path}」，输入新路径（可含 "/" 调整层级）：`, path)
  if (!newPath || newPath.trim() === path) return
  try {
    await api('/api/knowledge/category-rename', {
      method: 'POST',
      body: JSON.stringify({ oldPath: path, newPath: newPath.trim() }),
    })
    if (activeCategory.value === path || activeCategory.value.startsWith(`${path}/`)) {
      activeCategory.value = newPath.trim()
    }
    await loadCategories()
    await load()
    notice.value = '分类已重命名'
  } catch (e: any) {
    error.value = e.message
  }
}

// ---- 批量归类 ----
const batchMode = ref(false)
const selectedIds = ref(new Set<string>())
const batchCategory = ref('')

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  selectedIds.value = new Set()
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

async function applyBatch() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  try {
    const r = await api<{ updated: number }>('/api/knowledge/batch-category', {
      method: 'POST',
      body: JSON.stringify({ ids, category: batchCategory.value.trim() || undefined }),
    })
    notice.value = `已归类 ${r.updated} 篇`
    selectedIds.value = new Set()
    batchMode.value = false
    await load()
    await loadCategories()
  } catch (e: any) {
    error.value = e.message
  }
}

// ---- 导入 ----
function triggerFile() {
  fileInput.value?.click()
}

function triggerDir() {
  dirInput.value?.click()
}

function parseMarkdown(filename: string, content: string) {
  const lines = content.split(/\r?\n/)
  const heading = lines[0]?.trim().match(/^#\s+(.+)$/)
  if (heading) {
    return { title: heading[1].trim(), content: lines.slice(1).join('\n').trim() }
  }
  const base = filename.replace(/\.(md|markdown)$/i, '')
  return { title: base, content: content.trim() }
}

async function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  const mdFiles = files.filter((f) => /\.(md|markdown)$/i.test(f.name))
  if (!mdFiles.length) {
    error.value = '未找到 .md / .markdown 文件'
    return
  }
  importing.value = true
  error.value = ''
  notice.value = ''
  try {
    const items: Array<{ title: string; content: string; tags: string[]; category?: string }> = []
    for (const f of mdFiles) {
      const content = await f.text()
      const { title, content: body } = parseMarkdown(f.name, content)
      const tags: string[] = []
      let category: string | undefined
      const rel = (f as any).webkitRelativePath as string | undefined
      if (rel && rel.includes('/')) {
        const parts = rel.split('/')
        const topDir = parts[0]
        const subDirs = parts.slice(1, -1)
        if (subDirs.length) category = subDirs.join('/')
        else if (topDir) tags.push(topDir)
      }
      items.push({ title, content: body, tags, category })
    }
    const r = await api<{ created: number }>('/api/knowledge/import', {
      method: 'POST',
      body: JSON.stringify({ entries: items }),
    })
    notice.value = `成功导入 ${r.created} 个条目`
    await load()
    await loadCategories()
    if (searchQ.value.trim()) await doSearch()
  } catch (e: any) {
    error.value = e.message
  } finally {
    importing.value = false
  }
}

function scrollToHeading(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

watch(lastEvent, (ev) => {
  if (ev?.type === 'knowledge:changed') {
    load()
    loadCategories()
  }
})

onMounted(() => {
  load()
  loadCategories()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement
  const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    if (editing.value) {
      e.preventDefault()
      save()
    }
    return
  }
  if (inInput) return

  if (e.key === '/') {
    e.preventDefault()
    searchInput.value?.focus()
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault()
    openCreate()
  }
}
</script>

<template>
  <div class="kb card">
    <!-- 移动端/平板工具栏 -->
    <header class="kb-toolbar">
      <button class="tb-btn" title="分类" @click="showSidebar = true">☰</button>
      <span class="tb-title">{{ selected?.title ?? '知识库' }}</span>
      <button class="tb-btn" title="文章列表" @click="showRight = true">📄</button>
    </header>

    <!-- 左栏：详情视图显示大纲 TOC，列表视图显示目录树 -->
    <aside class="kb-side" :class="{ open: showSidebar }">
      <!-- 详情视图：大纲 TOC -->
      <template v-if="selected && !editing">
        <button class="btn secondary sm" style="align-self: flex-start" @click="selectedId = ''">
          ← 返回列表
        </button>
        <div class="side-title">目录大纲</div>
        <div v-if="rendered.toc.length" class="toc-list">
          <div
            v-for="h in rendered.toc"
            :key="h.id"
            class="toc-item"
            :style="{ paddingLeft: 8 + (h.level - 1) * 14 + 'px' }"
            @click="scrollToHeading(h.id)"
          >
            {{ h.text }}
          </div>
        </div>
        <div v-else class="muted" style="font-size: 12px; padding: 4px 8px">无标题大纲</div>
      </template>

      <!-- 列表视图：目录树 + 操作 -->
      <template v-else>
      <input
        ref="searchInput"
        v-model="searchQ"
        class="kb-search"
        placeholder="搜索标题 / 内容...（按 / 聚焦）"
        @input="onSearchInput"
      />
      <div class="side-actions">
        <button class="btn sm" @click="openCreate">＋ 新建</button>
        <button class="btn secondary sm" @click="showAddCategory = !showAddCategory">＋ 分类</button>
      </div>

      <div v-if="showAddCategory" class="add-cat">
        <input
          v-model="newCategory"
          placeholder="分类路径，如 技术/前端"
          @keydown.enter="addCategory"
        />
        <div class="row" style="gap: 6px">
          <button class="btn sm" @click="addCategory">添加</button>
          <button class="btn secondary sm" @click="showAddCategory = false">取消</button>
        </div>
      </div>

      <div class="side-actions">
        <button class="btn secondary sm" :disabled="importing" @click="triggerFile">
          导入文件
        </button>
        <button class="btn secondary sm" :disabled="importing" @click="triggerDir">
          导入文件夹
        </button>
      </div>

      <div v-if="error" class="error" style="margin: 0">{{ error }}</div>
      <div v-if="notice" class="notice">{{ notice }}</div>

      <div class="status-filter">
        <div
          v-for="s in ['all', 'draft', 'published', 'archived']"
          :key="s"
          class="status-filter-item"
          :class="{ active: statusFilter === s }"
          @click="statusFilter = s as any"
        >
          {{ s === 'all' ? '全部' : STATUS_LABEL[s] }}
        </div>
      </div>

      <select v-model="timeFilter" class="sort-select" style="width: 100%">
        <option value="all">全部时间</option>
        <option value="7d">最近 7 天</option>
        <option value="30d">最近 30 天</option>
        <option value="90d">最近 90 天</option>
      </select>

      <div class="cat-section">
        <div
          class="cat-all"
          :class="{ active: !activeCategory }"
          @click="activeCategory = ''"
        >
          全部 <span class="muted">{{ entries.length }}</span>
        </div>
        <CategoryTree
          v-if="categories.length"
          :nodes="categories"
          :active-path="activeCategory"
          @select="selectCategory"
          @remove="removeCategory"
          @rename="renameCategory"
        />
        <div v-else class="muted" style="font-size: 12px; padding: 4px 8px">暂无分类</div>
      </div>

      <div class="stats-box">
        <div class="stat-item"><span>{{ entries.length }}</span> 文档</div>
        <div class="stat-item"><span>{{ tags.length }}</span> 标签</div>
        <div class="stat-item"><span>{{ totalWords }}</span> 字</div>
      </div>

      <div class="trash-entry" :class="{ active: view === 'trash' }" @click="showTrash">
        🗑 回收站
      </div>

      <div v-if="recentEntries.length" class="recent-section">
        <div class="right-title" style="padding: 8px 8px 4px">最近访问</div>
        <div
          v-for="e in recentEntries"
          :key="e.id"
          class="recent-item"
          :class="{ active: e.id === selectedId }"
          @click="select(e.id)"
        >
          {{ e.title }}
        </div>
      </div>
      </template>
    </aside>

    <!-- 中栏：文章内容（Markdown 渲染） -->
    <section class="kb-content">
      <div class="content-wrap" @click="onContentClick">
        <div v-if="view === 'trash'" class="trash-view">
          <div class="row" style="justify-content: space-between; margin-bottom: 16px">
            <h3 style="margin: 0">回收站</h3>
            <div class="row">
              <button class="btn danger sm" :disabled="!trashEntries.length" @click="emptyTrash">清空</button>
              <button class="btn secondary sm" @click="showList">返回</button>
            </div>
          </div>
          <div v-if="trashEntries.length">
            <div v-for="e in trashEntries" :key="e.id" class="trash-item">
              <div class="row" style="justify-content: space-between">
                <div>
                  <div class="trash-title">{{ e.title }}</div>
                  <div class="muted">删除于 {{ new Date(e.deletedAt ?? 0).toLocaleString() }}</div>
                </div>
                <div class="row">
                  <button class="btn sm" @click="restoreEntry(e.id)">恢复</button>
                  <button class="btn danger sm" @click="purgeEntry(e.id)">彻底删除</button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty">回收站为空</div>
        </div>

        <div v-else-if="!editing && !selected" class="list-view">
          <div class="list-header">
            <h3 style="margin: 0">{{ searchQ.trim() ? '搜索结果' : '知识库' }}</h3>
            <span class="muted">{{ display.length }} 篇</span>
          </div>
          <div v-if="display.length" class="card-list">
            <div v-for="e in display" :key="e.id" class="card-item" @click="select(e.id)">
              <div class="card-title">
                <span v-if="e.pinned" class="pin-icon">📌</span>
                <span v-html="highlight(e.title, searchQ)"></span>
              </div>
              <div v-if="e.category || e.tags.length" class="card-tags">
                <span v-if="e.category" class="badge">📁 {{ e.category }}</span>
                <span v-for="t in e.tags" :key="t" class="badge">{{ t }}</span>
              </div>
              <div class="card-summary muted">{{ e.summary || e.content.slice(0, 120) }}</div>
              <div class="card-meta muted">
                <span class="status-dot" :class="e.status ?? 'published'"></span>
                {{ STATUS_LABEL[e.status ?? 'published'] }} · {{ new Date(e.updatedAt).toLocaleDateString() }}
              </div>
            </div>
          </div>
          <div v-else class="empty">暂无文章，点击「＋ 新建」或「导入」开始</div>
        </div>

        <div v-else-if="editing" class="editor">
          <h3 style="margin-top: 0">{{ selectedId && selected ? '编辑' : '新建' }}文章</h3>
          <div class="editor-grid">
            <div class="editor-form">
              <div class="field">
                <label>标题</label>
                <input v-model="form.title" placeholder="标题" />
              </div>
              <div class="field">
                <label>分类（路径，如 技术/前端）</label>
                <input v-model="form.category" list="category-options" placeholder="可选" />
                <datalist id="category-options">
                  <option v-for="p in categoryPaths" :key="p" :value="p" />
                </datalist>
              </div>
              <div class="field">
                <label>内容（Markdown）</label>
                <textarea v-model="form.content" placeholder="支持 Markdown 语法" />
              </div>
              <div class="field">
                <label>标签（逗号分隔）</label>
                <input v-model="form.tags" placeholder="ai, 教程, 笔记" />
              </div>
              <div class="row">
                <button class="btn" @click="save">保存</button>
                <button class="btn secondary" @click="cancelEdit">取消</button>
              </div>
            </div>
            <div class="editor-preview">
              <div class="editor-preview-head">预览</div>
              <div class="markdown-body" v-html="previewHtml"></div>
            </div>
          </div>
        </div>

        <template v-else-if="selected">
          <header class="article-head">
            <!-- 面包屑导航 -->
            <div v-if="breadcrumbParts.length" class="breadcrumb">
              <span class="crumb" @click="activeCategory = ''">全部</span>
              <template v-for="(part, i) in breadcrumbParts" :key="i">
                <span class="crumb-sep">/</span>
                <span class="crumb" @click="activeCategory = breadcrumbPaths[i]">{{ part }}</span>
              </template>
            </div>

            <h1 class="article-title">
              {{ selected.title }}
              <span v-if="selected.pinned" class="pin-icon">📌</span>
            </h1>

            <!-- 状态徽标 + 切换 -->
            <div class="status-row">
              <span class="status-badge" :class="selected.status ?? 'published'">
                {{ STATUS_LABEL[selected.status ?? 'published'] }}
              </span>
              <div class="row" style="gap: 6px">
                <button
                  v-for="s in ['draft', 'published', 'archived']"
                  :key="s"
                  class="btn sm"
                  :class="(selected.status ?? 'published') === s ? '' : 'secondary'"
                  @click="changeStatus(s as any)"
                >
                  {{ STATUS_LABEL[s] }}
                </button>
              </div>
            </div>

            <div class="row" style="justify-content: space-between">
              <div v-if="selected.category || selected.tags.length" class="article-tags">
                <span v-if="selected.category" class="badge">📁 {{ selected.category }}</span>
                <span v-for="t in selected.tags" :key="t" class="badge">{{ t }}</span>
              </div>
              <div class="row">
                <button class="btn secondary sm" @click="likeEntry">
                  👍 {{ selected.likes ?? 0 }}
                </button>
                <button class="btn secondary sm" @click="shareEntry">分享</button>
                <button class="btn secondary sm" @click="togglePin">
                  {{ selected.pinned ? '取消置顶' : '置顶' }}
                </button>
                <button class="btn secondary sm" @click="exportEntry">导出</button>
                <button class="btn secondary sm" @click="showHistory = !showHistory">
                  历史{{ selected.history?.length ? `(${selected.history.length})` : '' }}
                </button>
                <button class="btn secondary sm" @click="openEdit">编辑</button>
                <button class="btn danger sm" @click="remove">删除</button>
              </div>
            </div>
            <div class="muted" style="margin-top: 8px">
              更新于 {{ new Date(selected.updatedAt).toLocaleString() }}
            </div>
          </header>

          <!-- AI 摘要 + 评分 -->
          <div class="summary-row">
            <div class="summary-box">
              <div class="summary-head">
                <span class="summary-label">摘要</span>
                <button
                  class="btn secondary sm"
                  :disabled="summarizing"
                  @click="generateSummary"
                >
                  {{ summarizing ? '生成中…' : selected.summary ? '重新生成' : 'AI 生成摘要' }}
                </button>
              </div>
              <div v-if="selected.summary" class="summary-text">{{ selected.summary }}</div>
            </div>
            <div class="rating-row">
              <span class="muted" style="margin-right: 4px">评分</span>
              <span
                v-for="n in 5"
                :key="n"
                class="star"
                :class="{ on: (selected.rating ?? 0) >= n }"
                @click="rateEntry(n)"
              >★</span>
            </div>
          </div>

          <article class="markdown-body" v-html="rendered.html"></article>

          <!-- 版本历史 -->
          <div v-if="showHistory" class="history-panel">
            <div class="history-head">版本历史</div>
            <div v-if="selected.history?.length">
              <div v-for="h in selected.history" :key="h.version" class="history-item">
                <div class="row" style="justify-content: space-between">
                  <div>
                    <span class="badge">v{{ h.version }}</span>
                    <span class="muted" style="margin-left: 6px">
                      {{ new Date(h.updatedAt).toLocaleString() }}
                    </span>
                  </div>
                  <button class="btn secondary sm" @click="restoreVersion(h.version)">回滚</button>
                </div>
                <div class="muted history-title">标题：{{ h.title }}</div>
              </div>
            </div>
            <div v-else class="muted">暂无历史版本（编辑保存后会自动记录）</div>
          </div>
        </template>
      </div>
    </section>

    <!-- 右栏：详情视图显示文章列表，列表视图显示热词标签 -->
    <aside class="kb-right" :class="{ open: showRight }">
      <!-- 详情视图：文章列表 -->
      <template v-if="selected">
      <div class="kb-right-list">
        <div class="right-title" style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
          文章列表
          <div class="row" style="gap: 6px">
            <select v-model="sortOption" class="sort-select">
              <option value="updated">更新时间</option>
              <option value="title">标题</option>
              <option value="created">创建时间</option>
            </select>
            <button class="btn secondary sm" @click="toggleBatchMode">
              {{ batchMode ? '取消' : '批量归类' }}
            </button>
          </div>
        </div>

        <div v-if="batchMode" class="batch-bar">
          <input
            v-model="batchCategory"
            list="category-options"
            placeholder="目标分类（留空 = 取消归类）"
          />
          <button class="btn sm" :disabled="!selectedIds.size" @click="applyBatch">
            应用({{ selectedIds.size }})
          </button>
        </div>

        <div v-if="display.length">
          <div
            v-for="e in display"
            :key="e.id"
            class="kb-item"
            :class="{ active: !batchMode && e.id === selectedId }"
            @click="batchMode ? toggleSelect(e.id) : select(e.id)"
          >
            <div class="kb-item-row">
              <div v-if="batchMode" class="kb-check" :class="{ on: selectedIds.has(e.id) }">
                {{ selectedIds.has(e.id) ? '✓' : '' }}
              </div>
              <div style="flex: 1; min-width: 0">
                <div class="kb-item-title">
                  <span v-if="e.pinned" class="pin-icon">📌</span>
                  <span
                    class="status-dot"
                    :class="e.status ?? 'published'"
                    :title="STATUS_LABEL[e.status ?? 'published']"
                  ></span>
                  <span v-html="highlight(e.title, searchQ)"></span>
                </div>
                <div v-if="e.category || e.tags.length" class="kb-item-tags">
                  <span v-if="e.category" class="badge">📁 {{ e.category }}</span>
                  <span v-for="t in e.tags" :key="t" class="badge">{{ t }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty">暂无文章</div>
      </div>
      </template>

      <!-- 列表视图：热词标签 -->
      <template v-else>
        <div class="kb-right-list">
          <div class="right-title">热门标签</div>
          <div v-if="tags.length" class="hot-tags">
            <span
              v-for="t in tags"
              :key="t.name"
              class="badge hot-tag"
              @click="searchQ = t.name; doSearch()"
            >
              {{ t.name }} ({{ t.count }})
            </span>
          </div>
          <div v-else class="muted" style="font-size: 13px; padding: 4px 8px">暂无标签</div>
        </div>
      </template>
    </aside>

    <!-- 抽屉遮罩 -->
    <div v-if="showSidebar || showRight" class="kb-overlay" @click="closeDrawers"></div>

    <input
      ref="fileInput"
      type="file"
      accept=".md,.markdown"
      multiple
      hidden
      @change="onFileSelect"
    />
    <input ref="dirInput" type="file" webkitdirectory hidden @change="onFileSelect" />

    <!-- 图片放大预览 -->
    <div v-if="lightboxSrc" class="lightbox" @click="closeLightbox">
      <img :src="lightboxSrc" alt="预览" />
    </div>

    <!-- 移动端悬浮锚点按钮（详情页，打开大纲） -->
    <button
      v-if="selected && !editing"
      class="fab-anchor"
      title="目录大纲"
      @click="showSidebar = true"
    >
      ☰
    </button>
  </div>
</template>

<style scoped>
.kb {
  display: flex;
  gap: 12px;
  height: calc(100vh - 140px);
  height: calc(100dvh - 140px);
  padding: 0;
  position: relative;
  max-width: 1440px;
  margin: 0 auto;
}

/* 工具栏：默认隐藏，移动端显示 */
.kb-toolbar {
  display: none;
}

/* 左栏 */
.kb-side {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 12px;
  overflow-y: auto;
  background: var(--panel);
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.kb-search {
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
}

.side-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.add-cat {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.add-cat input {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
}

.notice {
  background: #ecfdf5;
  color: var(--ok);
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
}

.cat-section {
  margin-top: 4px;
}

.cat-all {
  display: flex;
  justify-content: space-between;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.cat-all:hover {
  background: #f1f3f7;
}

.cat-all.active {
  background: #eef2ff;
  color: var(--primary-dark);
}

.trash-entry {
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--muted);
  margin-top: 8px;
  border-top: 1px solid var(--border);
}

.stats-box {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

.stat-item {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: var(--muted);
}

.stat-item span {
  display: block;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}

.trash-entry:hover {
  background: #f1f3f7;
}

.trash-entry.active {
  background: #eef2ff;
  color: var(--primary-dark);
  font-weight: 600;
}

.trash-view {
  padding: 8px 0;
}

.trash-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
}

.trash-title {
  font-weight: 600;
  font-size: 14px;
}

.recent-section {
  margin-top: 8px;
}

.recent-item {
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-item:hover {
  background: #f1f3f7;
  color: var(--text);
}

.recent-item.active {
  background: #eef2ff;
  color: var(--primary-dark);
}

/* 中栏：内容 */
.kb-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background: var(--panel);
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.content-wrap {
  max-width: 900px;
  margin: 0 auto;
  padding: 28px 36px;
}

/* 左栏大纲标题 */
.side-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 8px 8px 4px;
}

.toc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 中栏列表视图（卡片） */
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.card-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.card-item {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.card-item:hover {
  border-color: var(--primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}

.card-tags {
  margin-bottom: 8px;
}

.card-summary {
  font-size: 13px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-meta {
  margin-top: 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 热词标签 */
.hot-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 8px;
}

.hot-tag {
  cursor: pointer;
  transition: opacity 0.15s;
}

.hot-tag:hover {
  opacity: 0.75;
}

.editor textarea {
  min-height: 300px;
}

.editor-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  align-items: start;
}

.editor-preview {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  max-height: calc(100dvh - 240px);
  overflow-y: auto;
}

.editor-preview-head {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
}

:deep(mark) {
  background: #fef08a;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

@media (max-width: 768px) {
  .editor-grid {
    grid-template-columns: 1fr;
  }
}

.article-head {
  border-bottom: 1px solid var(--border);
  padding-bottom: 16px;
  margin-bottom: 24px;
}

.article-title {
  margin: 0 0 12px;
  font-size: 26px;
  line-height: 1.3;
}

/* 面包屑 */
.breadcrumb {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 8px;
}

.crumb {
  cursor: pointer;
}

.crumb:hover {
  color: var(--primary-dark);
}

.crumb-sep {
  margin: 0 6px;
  color: var(--border);
}

/* 状态 */
.status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
}

.status-badge {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.status-badge.draft {
  background: #f1f3f7;
  color: var(--muted);
}

.status-badge.published {
  background: #ecfdf5;
  color: var(--ok);
}

.status-badge.archived {
  background: #fff7ed;
  color: #ea580c;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}

.status-dot.draft {
  background: var(--muted);
}

.status-dot.published {
  background: var(--ok);
}

.status-dot.archived {
  background: #ea580c;
}

.status-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.status-filter-item {
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  color: var(--muted);
  background: #f1f3f7;
}

.status-filter-item:hover {
  background: #e4e7ec;
}

.status-filter-item.active {
  background: var(--primary);
  color: #fff;
}

.article-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* AI 摘要 + 评分 */
.summary-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 12px 14px;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 20px;
}

.summary-box {
  flex: 1;
  min-width: 0;
}

.summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.summary-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.summary-text {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text);
}

.rating-row {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.star {
  font-size: 20px;
  color: #d1d5db;
  cursor: pointer;
  transition: color 0.15s, transform 0.1s;
}

.star:hover {
  transform: scale(1.15);
}

.star.on {
  color: #f59e0b;
}

/* 右栏：列表 + 目录 */
.kb-right {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.right-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 12px 14px 8px;
}

.kb-right-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 10px;
}

.kb-toc {
  max-height: 45%;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding: 0 10px 12px;
}

.toc-item {
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toc-item:hover {
  background: #f1f3f7;
  color: var(--text);
}

.kb-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.kb-item:hover {
  border-color: var(--primary);
}

.kb-item.active {
  border-color: var(--primary);
  background: var(--primary);
}

.kb-item.active .kb-item-title {
  color: #fff;
}

.kb-item.active .badge {
  background: rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.9);
}

.kb-item-title {
  font-size: 13px;
  font-weight: 600;
}

.pin-icon {
  margin-right: 2px;
}

.sort-select {
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  background: #fff;
}

.kb-item-tags {
  margin-top: 4px;
}

.batch-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 4px 10px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
}

.batch-bar input {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
}

.kb-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kb-check {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 4px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  transition: all 0.15s;
}

.kb-check.on {
  background: var(--primary);
  border-color: var(--primary);
}

/* 图片放大预览 */
.lightbox {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.85);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}

.lightbox img {
  max-width: 92%;
  max-height: 92%;
  border-radius: 8px;
}

.markdown-body img {
  cursor: zoom-in;
}

/* 版本历史 */
.history-panel {
  margin-top: 24px;
  border-top: 1px solid var(--border);
  padding-top: 16px;
}

.history-head {
  font-weight: 700;
  margin-bottom: 12px;
}

.history-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.history-title {
  margin-top: 4px;
  font-size: 12px;
}

/* 抽屉遮罩 */
.kb-overlay {
  display: none;
}

/* 移动端悬浮锚点按钮 */
.fab-anchor {
  display: none;
}

/* ===== 超宽屏（≥1920px，PRD XL）：侧栏对齐详情页 260/280，正文保持 900 ===== */
@media (min-width: 1920px) {
  .kb-side {
    width: 260px;
  }
  .kb-right {
    width: 280px;
  }
}

/* ===== 平板（≤1024px，PRD M）：右栏变抽屉 ===== */
@media (max-width: 1024px) {
  .kb-right {
    position: fixed;
    top: 0;
    bottom: 0;
    right: -300px;
    width: 300px;
    z-index: 200;
    box-shadow: -4px 0 20px rgba(0, 0, 0, 0.12);
    transition: right 0.25s ease;
  }
  .kb-right.open {
    right: 0;
  }
  .kb-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.4);
    z-index: 150;
  }
}

/* ===== 移动（≤768px，PRD S）：左栏也变抽屉 + 工具栏 ===== */
@media (max-width: 768px) {
  .kb {
    flex-direction: column;
    height: calc(100dvh - 110px);
  }
  .kb-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .tb-btn {
    border: 1px solid var(--border);
    background: #fff;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
  }
  .tb-title {
    flex: 1;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kb-side {
    position: fixed;
    top: 0;
    bottom: 0;
    left: -260px;
    width: 260px;
    z-index: 200;
    box-shadow: 4px 0 20px rgba(0, 0, 0, 0.12);
    transition: left 0.25s ease;
  }
  .kb-side.open {
    left: 0;
  }
  .kb-content {
    width: 100%;
  }
  .content-wrap {
    padding: 16px;
  }
  .article-title {
    font-size: 22px;
  }
  .fab-anchor {
    display: flex;
    position: fixed;
    right: 16px;
    bottom: 24px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--primary);
    color: #fff;
    border: none;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    z-index: 300;
    cursor: pointer;
  }
}
</style>
