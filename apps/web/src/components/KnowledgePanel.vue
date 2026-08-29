<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject, type Ref } from 'vue'
import { api, type KnowledgeEntry, type EventItem, type CategoryNode } from '../lib/api'
import { renderMarkdown, type TocItem } from '../lib/markdown'
import CategoryTree from './CategoryTree.vue'
import DocTreeItem from './DocTreeItem.vue'

const lastEvent = inject<Ref<EventItem | null>>('lastEvent', ref(null))

const entries = ref<KnowledgeEntry[]>([])
const categories = ref<CategoryNode[]>([])
const searchQ = ref('')
const searchResults = ref<Array<{ entry: KnowledgeEntry; score: number }>>([])
const activeCategory = ref('')
const selectedId = ref(localStorage.getItem('ikit-kb-selected') ?? '')
const activeHeading = ref('')
const tocCollapsed = ref(false)
const kbContentEl = ref<HTMLElement | null>(null)
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

// 子文档创建父 id（点击「＋」建子文档时设置，用于新建后刷新树展开）
const createChildParent = ref('')

// 新建顶层文档
function createRootDoc() {
  createChildParent.value = ''
  showRight.value = false
  openCreate('')
}

// 新建子文档（parentId 指向父文档）
function createChildDoc(parentId: string) {
  createChildParent.value = parentId
  showRight.value = false
  openCreate()
  // 展开父节点方便看到新子文档
  expandedDocs.value = { ...expandedDocs.value, [parentId]: true }
}

// 移动文档到目标父（parentId 为空 = 顶层）
async function moveDoc(id: string, parentId: string | '') {
  await api(`/api/knowledge/entries/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ parentId: parentId || null }),
  })
  menuFor.value = ''
  await load()
}

// ---- 树形移动选择器 ----
const movePickerFor = ref('') // 正在选择移动目标的文档 id
const moveTargetParent = ref<string | ''>('') // 选择的目标父（'' = 根目录）
const moveTreeExpanded = ref<Record<string, boolean>>({})

// 打开移动面板
function openMovePicker(id: string) {
  menuFor.value = ''
  const entry = entries.value.find((e) => e.id === id)
  moveTargetParent.value = entry?.parentId ?? ''
  movePickerFor.value = id
  moveTreeExpanded.value = {}
}

function toggleMoveTree(id: string) {
  moveTreeExpanded.value = { ...moveTreeExpanded.value, [id]: !moveTreeExpanded.value[id] }
}

// 确认移动
async function confirmMove() {
  const id = movePickerFor.value
  movePickerFor.value = ''
  if (!id) return
  // 防循环：不能移到自己或子孙下
  if (isForbiddenTarget(moveTargetParent.value, id)) {
    error.value = '不能移动到自身或其子文档下'
    return
  }
  await api(`/api/knowledge/entries/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ parentId: moveTargetParent.value || null }),
  })
  await load()
}

function closeMovePicker() {
  movePickerFor.value = ''
}

// 不允许移到自己或自己的子孙（防循环）
function isForbiddenTarget(targetId: string | '', id: string): boolean {
  if (targetId === id) return true
  // 判断 target 是否在 id 的子树内
  const idSet = new Set<string>([id])
  const walk = (nodeId: string) => {
    const children = entries.value.filter((e) => e.parentId === nodeId && !e.deletedAt)
    for (const c of children) {
      idSet.add(c.id)
      walk(c.id)
    }
  }
  walk(id)
  return !!targetId && idSet.has(targetId)
}

// ---- 拖拽排序 / 移动 ----
const dragId = ref('')
const overId = ref('')
const overPos = ref<'top' | 'middle' | 'bottom'>('middle')
const dragParent = ref<string | ''>('')

function onDragStart(id: string) {
  dragId.value = id
  const entry = entries.value.find((e) => e.id === id)
  dragParent.value = entry?.parentId ?? ''
}

function onDragOver(id: string, pos: 'top' | 'middle' | 'bottom') {
  if (id !== dragId.value) {
    overId.value = id
    overPos.value = pos
  }
}

async function onDropTo(targetId: string, pos: 'top' | 'middle' | 'bottom') {
  const dragged = dragId.value
  dragId.value = ''
  overId.value = ''
  overPos.value = 'middle'
  const over = targetId
  if (!dragged || !over || dragged === over) return
  // 若目标是被拖节点的子孙 → 忽略（防循环）
  if (isForbiddenTarget(over, dragged)) return

  // 行中部 = 移动为该文档的子文档（跨级，即使原同父级也可）
  if (pos === 'middle') {
    await api(`/api/knowledge/entries/${dragged}/move`, {
      method: 'POST',
      body: JSON.stringify({ parentId: over }),
    })
    expandedDocs.value = { ...expandedDocs.value, [over]: true }
    await load()
    return
  }

  // 上/下边缘 = 同级插入。为保证落入同级，先确保被拖与目标同父；
  // 若不同父，则把被拖移到目标父级下，再做同级排序。
  let pid = (entries.value.find((e) => e.id === over)?.parentId ?? '') as string | ''
  const draggedEntry = entries.value.find((e) => e.id === dragged)
  if ((draggedEntry?.parentId || undefined) !== (pid || undefined)) {
    await api(`/api/knowledge/entries/${dragged}/move`, {
      method: 'POST',
      body: JSON.stringify({ parentId: pid || null }),
    })
  }
  const siblings = entries.value
    .filter((e) => !e.deletedAt && (e.parentId || undefined) === (pid || undefined))
    .sort((a, b) => {
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER
      return ao - bo
    })
    .map((e) => e.id)
  const fromIdx = siblings.indexOf(dragged)
  const toIdx = siblings.indexOf(over)
  if (fromIdx < 0 || toIdx < 0) {
    await load()
    return
  }
  siblings.splice(fromIdx, 1)
  // 插入位置：top = 在 over 之前；bottom = 在 over 之后
  const insertAt = siblings.indexOf(over)
  siblings.splice(pos === 'top' ? insertAt : insertAt + 1, 0, dragged)
  await api('/api/knowledge/reorder', {
    method: 'POST',
    body: JSON.stringify({ parentId: pid || null, ids: siblings }),
  })
  await load()
}

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

// 标签云字号：按出现次数映射到 12~24px（min=1 次 → 12px，max → 24px）
function tagCloudSize(count: number): number {
  const maxCount = Math.max(1, ...tags.value.map((t) => t.count))
  const min = 12
  const max = 24
  if (maxCount === 1) return (min + max) / 2
  const ratio = (count - 1) / (maxCount - 1)
  return Math.round(min + ratio * (max - min))
}

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

// 文档树（基于 parentId 的递归树）
const expandedDocs = ref<Record<string, boolean>>({})

type DocNode = { entry: KnowledgeEntry; children: DocNode[] }

const docTree = computed<DocNode[]>(() => {
  const map = new Map<string, DocNode>()
  const roots: DocNode[] = []
  for (const e of display.value) {
    map.set(e.id, { entry: e, children: [] })
  }
  for (const e of display.value) {
    const node = map.get(e.id)!
    if (e.parentId && map.has(e.parentId)) {
      map.get(e.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortNodes = (nodes: DocNode[]) => {
    nodes.sort((a, b) => {
      if (!!a.entry.pinned !== !!b.entry.pinned) return a.entry.pinned ? -1 : 1
      const ao = a.entry.sortOrder ?? Number.MAX_SAFE_INTEGER
      const bo = b.entry.sortOrder ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
      return b.entry.updatedAt.localeCompare(a.entry.updatedAt)
    })
    nodes.forEach((n) => sortNodes(n.children))
  }
  sortNodes(roots)
  return roots
})

function toggleDocExpand(id: string) {
  expandedDocs.value = { ...expandedDocs.value, [id]: !expandedDocs.value[id] }
}

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

function openCreate(category?: string) {
  editing.value = true
  showRight.value = false
  selectedId.value = ''
  form.value =
    loadDraft() ?? { title: '', content: '', tags: '', category: category ?? activeCategory.value }
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
        body: JSON.stringify({ ...payload, parentId: createChildParent.value || undefined }),
      })
      selectedId.value = r.entry.id
    }
    editing.value = false
    createChildParent.value = ''
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

// 阅读时长（按中文/英文混排字数估算，约 250 字/分钟）
const readMinutes = computed(() => {
  const c = selected.value?.content ?? ''
  return Math.max(1, Math.ceil(c.length / 250))
})

// 相对时间（x分钟前 / x小时前 / 昨天 / x天前 / 日期）
function relativeTime(iso: string): string {
  const d = new Date(iso).getTime()
  if (!d) return ''
  const diff = Date.now() - d
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day === 1) return '昨天'
  if (day < 30) return `${day}天前`
  return new Date(iso).toLocaleDateString()
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

function showArchive() {
  view.value = 'list'
  activeCategory.value = ''
  statusFilter.value = 'archived'
  searchQ.value = ''
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
const menuFor = ref('') // 当前打开的「⋯」菜单所属文档 id

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  selectedIds.value = new Set()
  menuFor.value = ''
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectAll() {
  // 全选/全不选当前 display
  const ids = display.value.map((e) => e.id)
  const allSelected = ids.length > 0 && ids.every((id) => selectedIds.value.has(id))
  const next = new Set(selectedIds.value)
  if (allSelected) {
    ids.forEach((id) => next.delete(id))
  } else {
    ids.forEach((id) => next.add(id))
  }
  selectedIds.value = next
}

const allDisplaySelected = computed(
  () => display.value.length > 0 && display.value.every((e) => selectedIds.value.has(e.id)),
)

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

// 批量删除（软删除到回收站）
async function batchDelete() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  if (!confirm(`确认删除选中的 ${ids.length} 篇？`)) return
  try {
    for (const id of ids) {
      await api(`/api/knowledge/entries/${id}`, { method: 'DELETE' })
    }
    notice.value = `已删除 ${ids.length} 篇`
    selectedIds.value = new Set()
    batchMode.value = false
    menuFor.value = ''
    await load()
    await loadCategories()
  } catch (e: any) {
    error.value = e.message
  }
}

// 批量置顶
async function batchPin() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  for (const id of ids) {
    await api(`/api/knowledge/entries/${id}/toggle-pin`, { method: 'POST' })
  }
  notice.value = `已切换 ${ids.length} 篇置顶`
  selectedIds.value = new Set()
  batchMode.value = false
  await load()
}

// 对任意文档 id 执行单项操作（先选中，再复用单项函数）
async function actOnEntry(id: string, fn: () => Promise<void> | void) {
  selectedId.value = id
  menuFor.value = ''
  await fn()
}

// 删除指定 id 的文档（用于 ⋯ 菜单）
async function removeEntryById(id: string) {
  const entry = entries.value.find((e) => e.id === id)
  if (!entry) return
  if (!confirm(`确认删除「${entry.title}」？`)) return
  await api(`/api/knowledge/entries/${id}`, { method: 'DELETE' })
  if (selectedId.value === id) selectedId.value = ''
  menuFor.value = ''
  await load()
  await loadCategories()
}

// 复制链接
async function copyLink(id: string) {
  const e = entries.value.find((x) => x.id === id)
  if (!e) return
  const link = `${location.origin}/api/share/${e.shareToken ?? ''}`
  try {
    await navigator.clipboard.writeText(link)
    notice.value = '链接已复制'
  } catch {
    prompt('复制链接：', link)
  }
}

// 新标签页打开（仅返回正文视图，无独立路由，用分享页）
function openInNewTab(id: string) {
  const e = entries.value.find((x) => x.id === id)
  const url = e?.shareToken
    ? `${location.origin}/api/share/${e.shareToken}`
    : `${location.origin}/?doc=${id}`
  window.open(url, '_blank')
}

function closeMenu() {
  menuFor.value = ''
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

// 目录当前高亮：随中栏滚动更新
function updateActiveHeading() {
  const items = rendered.value.toc
  if (!items.length) return
  const el = kbContentEl.value
  const top = el ? el.getBoundingClientRect().top : 0
  let current = items[0].id
  for (const h of items) {
    const node = document.getElementById(h.id)
    if (node && node.getBoundingClientRect().top - top <= 60) current = h.id
  }
  activeHeading.value = current
}

watch(
  () => [selectedId.value, rendered.value.toc.length],
  () => {
    activeHeading.value = ''
    if (selected.value && rendered.value.toc.length) {
      requestAnimationFrame(() => setTimeout(updateActiveHeading, 60))
    }
  },
)

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
  window.addEventListener('click', onOutsideClick)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('click', onOutsideClick)
})

function onOutsideClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (!t.closest('.doc-menu') && !t.closest('.ia-btn')) menuFor.value = ''
}

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
      <button class="tb-btn" title="分类 / 标签" @click="showRight = true">☷</button>
    </header>

    <!-- 左栏：搜索 + 操作 + 文档列表 + 统计 + 回收站 -->
    <aside class="kb-side" :class="{ open: showSidebar }">
      <div class="kb-header">
        <div class="kb-logo">📚 <span>个人</span></div>
        <input
          ref="searchInput"
          v-model="searchQ"
          class="kb-search"
          placeholder="🔍 搜索..."
          @input="onSearchInput"
        />
      </div>

      <div class="side-actions side-actions-row">
        <button class="btn secondary sm action-btn" :disabled="importing" @click="triggerFile">
          导入文件
        </button>
        <button class="btn secondary sm action-btn" :disabled="importing" @click="triggerDir">
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

      <div class="doc-list">
        <div class="right-title">
          <span class="tree-title">目录</span>
          <div class="tree-title-actions">
            <button class="tree-action" title="新建文档" @click="createRootDoc">＋</button>
            <button class="tree-action" title="批量操作" @click="toggleBatchMode">☰</button>
          </div>
        </div>

        <!-- 批量选择模式头部 -->
        <div v-if="batchMode" class="batch-select-bar">
          <div class="batch-select-head">
            <label class="batch-all">
              <input type="checkbox" :checked="allDisplaySelected" @change="toggleSelectAll" />
              <span>已选 {{ selectedIds.size }} 项</span>
            </label>
            <button class="btn-new batch-exit" @click="batchMode = false; selectedIds = new Set()">
              退出
            </button>
          </div>
          <div class="batch-bar">
            <input
              v-model="batchCategory"
              list="category-options"
              placeholder="目标分类（留空 = 取消归类）"
            />
            <button class="btn sm" :disabled="!selectedIds.size" @click="applyBatch">
              应用({{ selectedIds.size }})
            </button>
            <button class="btn danger sm" :disabled="!selectedIds.size" @click="batchDelete">删除</button>
            <button class="btn secondary sm" :disabled="!selectedIds.size" @click="batchPin">置顶</button>
          </div>
        </div>
        <div v-if="display.length">
          <DocTreeItem
            v-for="node in docTree"
            :key="node.entry.id"
            :node="node"
            :depth="0"
            :selected-id="selectedId"
            :batch-mode="batchMode"
            :search-q="searchQ"
            :expanded-docs="expandedDocs"
            :menu-for="menuFor"
            :highlight="highlight"
            :drag-id="dragId"
            :over-id="overId"
            :over-pos="overPos"
            @select="select"
            @toggle="toggleDocExpand"
            @toggle-select="toggleSelect"
            @menu="(id) => (menuFor = menuFor === id ? '' : id)"
            @add-child="createChildDoc"
            @drag-start="onDragStart"
            @drag-over="onDragOver"
            @drop="onDropTo"
            @drag-end="() => (dragId = '', overId = '')"
            @pick-move-target="openMovePicker"
          >
            <template #entry-menu="{ id }">
              <div class="doc-menu-item" @click="openInNewTab(id)">↗ 在新标签页打开</div>
              <div class="doc-menu-item" @click="actOnEntry(id, shareEntry)">🔗 分享</div>
              <div class="doc-menu-item" @click="copyLink(id)">📋 复制链接</div>
              <div class="doc-menu-item" @click="actOnEntry(id, exportEntry)">⬇ 导出</div>
              <div class="doc-menu-item" @click="actOnEntry(id, openEdit)">✏️ 编辑</div>
              <div class="doc-menu-item" @click="actOnEntry(id, togglePin)">
                📌 {{ entries.find((e) => e.id === id)?.pinned ? '取消置顶' : '置顶' }}
              </div>
              <div class="doc-menu-item" @click="removeEntryById(id)">🗑 删除</div>
            </template>
          </DocTreeItem>
        </div>
        <div v-else class="empty">暂无文档</div>
      </div>

      <!-- 树形移动选择器 -->
      <div v-if="movePickerFor" class="move-picker-overlay" @click.self="closeMovePicker">
        <div class="move-picker" @click.stop>
          <div class="move-picker-head">
            <span>移动到…</span>
            <button class="move-picker-close" @click="closeMovePicker">×</button>
          </div>
          <div class="move-picker-body">
            <div
              class="move-picker-root"
              :class="{ active: moveTargetParent === '' }"
              @click="moveTargetParent = ''"
            >
              📂 根目录
            </div>
            <DocTreeItem
              v-for="node in docTree"
              :key="'mp-' + node.entry.id"
              :node="node"
              :depth="0"
              selected-id=""
              :batch-mode="false"
              search-q=""
              :expanded-docs="moveTreeExpanded"
              menu-for=""
              :highlight="highlight"
              :move-picker-for="movePickerFor"
              :move-target-parent="moveTargetParent"
              :forbidden="isForbiddenTarget(node.entry.id, movePickerFor)"
              :move-pick-mode="true"
              @pick-move-target="moveTargetParent = node.entry.id"
              @toggle="toggleMoveTree"
            />
          </div>
          <div class="move-picker-foot">
            <button class="btn secondary sm" @click="closeMovePicker">取消</button>
            <button class="btn sm" @click="confirmMove">移动到</button>
          </div>
        </div>
      </div>
    </aside>

    <!-- 中栏：文章内容（Markdown 渲染） -->
    <section class="kb-content">
      <!-- 目录浮窗（飞书样式）：固定于内容左侧，不随正文滚动 -->
      <aside
        v-if="selected && !editing && rendered.toc.length && !tocCollapsed"
        class="toc-float"
      >
        <button class="toc-float-collapse" title="收起目录" @click="tocCollapsed = true">«</button>
        <div class="toc-float-list">
          <div
            v-for="h in rendered.toc"
            :key="h.id"
            class="toc-float-item"
            :class="{ active: activeHeading === h.id }"
            :style="{ paddingLeft: 10 + (h.level - 1) * 14 + 'px' }"
            @click="scrollToHeading(h.id)"
          >
            {{ h.text }}
          </div>
        </div>
      </aside>

      <div ref="kbContentEl" class="content-scroll" @scroll.passive="updateActiveHeading">
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

        <div v-else-if="!editing && !selected" class="empty-state">
          <div class="empty-state-icon">📖</div>
          <div class="empty-state-title">{{ searchQ.trim() ? '未找到匹配文档' : '选择或新建一篇文章' }}</div>
          <div class="empty-state-sub muted">
            {{ searchQ.trim() ? `在左侧列表查看“${searchQ}”的结果` : '从左侧文档列表选择一篇文章查看内容' }}
          </div>
          <button v-if="!searchQ.trim()" class="btn" @click="openCreate">＋ 新建</button>
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

            <!-- meta 行：分类标签 · 时间 · 阅读时长 -->
            <div class="doc-meta">
              <span v-if="selected.category || selected.tags.length" class="meta-tags">
                🏷️ {{ [selected.category, ...selected.tags].filter(Boolean).join(' · ') }}
              </span>
              <span>🕒 {{ relativeTime(selected.updatedAt) }}</span>
              <span>📄 {{ readMinutes }} 分钟阅读</span>
            </div>

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
      </div>

      <!-- 目录收起后的展开钮 -->
      <button
        v-if="selected && !editing && rendered.toc.length && tocCollapsed"
        class="toc-float-expand"
        title="展开目录"
        @click="tocCollapsed = false"
      >
        »
      </button>
    </section>

    <!-- 右栏：分类导航 + 热门标签 -->
    <aside class="kb-right" :class="{ open: showRight }">
      <div class="kb-right-list">
        <div class="right-title">🏷️ 全部标签</div>
        <div class="tag-cloud">
          <span
            class="cloud-tag"
            :class="{ active: !searchQ.trim() && !activeCategory }"
            :style="{ fontSize: tagCloudSize(entries.length) + 'px' }"
            @click="searchQ = ''; activeCategory = ''; doSearch()"
          >
            # 全部
          </span>
          <span
            v-for="t in tags"
            :key="t.name"
            class="cloud-tag"
            :class="{ active: searchQ.trim() === t.name }"
            :style="{ fontSize: tagCloudSize(t.count) + 'px' }"
            @click="searchQ = t.name; doSearch()"
          >
            # {{ t.name }}
          </span>
          <span v-if="!tags.length" class="muted" style="font-size: 13px">暂无标签</span>
        </div>

        <hr class="rate-divider" />

        <div class="right-title" style="margin-top: 4px">📂 分类</div>
        <div class="cat-nav">
          <div
            class="nav-item"
            :class="{ active: !!activeCategory }"
            @click="activeCategory = ''"
          >
            <span class="nav-ico">📁</span> 全部知识
          </div>
          <div v-if="categories.length" class="cat-tree">
            <CategoryTree
              :nodes="categories"
              :active-path="activeCategory"
              @select="selectCategory"
              @remove="removeCategory"
              @rename="renameCategory"
            />
          </div>
          <div v-else class="muted cat-empty">暂无分类</div>
        </div>

        <hr class="rate-divider" />
        <div class="cat-nav">
          <div class="nav-item" @click="showArchive">
            <span class="nav-ico">📥</span> 归档
          </div>
          <div class="nav-item" :class="{ active: view === 'trash' }" @click="showTrash">
            <span class="nav-ico">🗑️</span> 回收站
          </div>
        </div>

        <div class="stats-box">
          <div class="stat-item"><span>{{ entries.length }}</span> 文档</div>
          <div class="stat-item"><span>{{ tags.length }}</span> 标签</div>
          <div class="stat-item"><span>{{ totalWords }}</span> 字</div>
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
      </div>
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

/* 左栏：贴合背景的浅灰面板，非浮起卡片 */
.kb-side {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 10px;
  overflow: hidden;
  background: var(--bg);
  border-radius: 12px;
}

.kb-side .kb-header,
.kb-side .side-actions,
.kb-side .add-cat,
.kb-side .status-filter,
.kb-side .sort-select {
  flex-shrink: 0;
}

.kb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.kb-logo {
  font-size: 16px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.kb-logo span {
  background: var(--primary);
  color: #fff;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 11px;
}

.kb-search {
  flex: 1;
  min-width: 90px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg);
  color: var(--text);
  outline: none;
  transition: border-color 0.2s;
}

.kb-search:focus {
  border-color: var(--primary);
}

.btn-new {
  background: var(--primary);
  color: #fff;
  border: none;
  padding: 9px 14px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.2s;
  text-align: center;
}

.btn-new:hover {
  background: var(--primary-dark);
}

.side-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 操作按钮行：并排均分 */
.side-actions-row {
  display: flex;
  gap: 6px;
}

.side-actions-row .action-btn {
  flex: 1;
  justify-content: center;
  text-align: center;
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

.cat-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
}

.cat-empty {
  font-size: 13px;
  padding: 6px 8px;
}

/* 右栏导航项 */
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--muted);
  transition: background 0.2s, color 0.2s;
  margin-bottom: 1px;
}

.nav-item:hover {
  background: var(--panel);
  color: var(--text);
}

.nav-item.active {
  background: var(--primary-soft);
  color: var(--primary-dark);
  font-weight: 500;
}

.nav-item .nav-ico {
  flex-shrink: 0;
  font-size: 13px;
}

.nav-item .count {
  margin-left: auto;
  font-size: 11px;
  background: var(--border);
  padding: 0 8px;
  border-radius: 10px;
  color: var(--muted);
  flex-shrink: 0;
}

.nav-item.active .count {
  background: rgba(59, 130, 246, 0.2);
  color: var(--primary-dark);
}

[data-theme='dark'] .nav-item.active .count {
  color: var(--primary-dark);
}

[data-theme='dark'] .nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
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
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding: 12px 8px 4px;
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
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding: 8px 8px 0;
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
  background: var(--panel);
  color: var(--text);
}

[data-theme='dark'] .recent-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.recent-item.active {
  background: var(--primary-soft);
  color: var(--primary-dark);
}

[data-theme='dark'] .recent-item.active {
  background: var(--primary-soft);
  color: var(--primary-dark);
}

/* 左栏：文档列表 */
.doc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
}

.doc-list .right-title {
  padding: 8px 0 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tree-title {
  font-size: 13px;
  font-weight: 600;
}

.tree-title-actions {
  display: flex;
  gap: 4px;
}

.tree-action {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}

.tree-action:hover {
  background: var(--panel);
  color: var(--text);
}

/* 批量选择头部 */
.batch-select-bar {
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  margin-bottom: 4px;
}

.batch-select-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.batch-all {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}

.batch-all input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: pointer;
}

.batch-exit {
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
}

/* 树形移动选择器 */
.move-picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.35);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}

.move-picker {
  width: 340px;
  max-height: 70vh;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.move-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
  font-weight: 600;
}

.move-picker-close {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
}

.move-picker-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}

.move-picker-root {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  margin-bottom: 2px;
}

.move-picker-root:hover {
  background: #f1f3f7;
}

.move-picker-root.active {
  background: var(--primary-soft);
  color: var(--primary-dark);
  font-weight: 500;
}

[data-theme='dark'] .move-picker-root:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme='dark'] .move-picker {
  background: var(--panel);
}

.move-picker-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

/* 中栏：空状态 */
.empty-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
}

.empty-state-icon {
  font-size: 56px;
  opacity: 0.6;
}

.empty-state-title {
  font-size: 18px;
  font-weight: 600;
}

.empty-state-sub {
  font-size: 13px;
  max-width: 360px;
  line-height: 1.6;
}

/* 中栏：内容 */
.kb-content {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  background: var(--panel);
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  position: relative;
}

/* 内容滚动区 */
.content-scroll {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
}

/* 目录浮窗（飞书样式）：固定于内容左侧，不随正文滚动 */
.toc-float {
  position: sticky;
  top: 0;
  align-self: flex-start;
  height: 100%;
  width: 200px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 12px 8px;
}

.toc-float-collapse {
  display: flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px 8px;
  transition: color 0.15s;
}

.toc-float-collapse:hover {
  color: var(--primary-dark);
}

.toc-float-expand {
  position: sticky;
  top: 12px;
  align-self: flex-start;
  width: 30px;
  height: 30px;
  margin: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  z-index: 30;
}

.toc-float-expand:hover {
  background: var(--primary);
  color: #fff;
}

.toc-float-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toc-float-item {
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.15s, color 0.15s;
}

.toc-float-item:hover {
  background: #f1f3f7;
}

/* 飞书风格：当前项蓝色文字高亮，不加底块矩形 */
.toc-float-item.active {
  color: var(--primary-dark);
  font-weight: 600;
}

[data-theme='dark'] .toc-float-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme='dark'] .toc-float-item.active {
  color: var(--primary-dark);
}

[data-theme='dark'] .toc-float {
  background: var(--panel);
}

.content-wrap {
  max-width: 900px;
  margin: 0 auto;
  padding: 28px 36px;
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

.rate-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 10px 0;
}

/* 标签云（词云，瀑布流多列排列） */
.tag-cloud {
  columns: 2;
  column-gap: 8px;
  padding: 6px 10px 10px;
  line-height: 1.5;
}

.cloud-tag {
  break-inside: avoid;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  display: inline-block;
  margin: 2px 0;
  transition: color 0.15s, background 0.15s, transform 0.15s;
}

.cloud-tag:hover {
  color: var(--primary-dark);
  transform: scale(1.06);
}

.cloud-tag.active {
  background: var(--primary);
  color: #fff;
  padding: 1px 8px;
  border-radius: 6px;
}

[data-theme='dark'] .cloud-tag:hover {
  color: var(--primary-dark);
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
  margin: 0 0 8px;
  font-size: 26px;
  line-height: 1.3;
}

/* 文章 meta 行：分类 · 时间 · 阅读时长 */
.doc-meta {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--muted);
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 14px;
}

.doc-meta .meta-tags {
  font-size: 13px;
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
  background: var(--bg);
  border-radius: 12px;
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
  /* 小屏隐藏目录浮窗，避免遮挡正文 */
  .toc-float {
    display: none;
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
