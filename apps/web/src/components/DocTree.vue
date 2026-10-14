<script setup lang="ts">
import { ref, computed, onMounted, nextTick, inject, type Ref } from 'vue'
import { api, apiErrorMessage, type KnowledgeEntry } from '../lib/api'
import { authHeaders, listGroups, type Group } from '../lib/auth'
import DocTreeItem, { type DocNode } from './DocTreeItem.vue'
import EntryPermissionDialog from './EntryPermissionDialog.vue'
import BatchMoveDialog from './BatchMoveDialog.vue'
import BatchDeleteDialog from './BatchDeleteDialog.vue'

const emit = defineEmits<{
  (e: 'open', entry: KnowledgeEntry): void
  (e: 'edit', entry: KnowledgeEntry): void
  (e: 'createChild', parentId: string): void
  /** 批量操作成功：父组件据此刷新卡片流 / 右栏并 toast（目录树自身已 load()） */
  (e: 'changed', payload: { message: string }): void
}>()

// expandIds：需要自动展开并定位的文档（如批量导入的父文档），仅首次加载时执行一次
const props = defineProps<{ category?: string; tag?: string; expandIds?: string[] }>()

const treeRef = ref<HTMLElement | null>(null)
let located = false

const userRole = inject<Ref<string>>('userRole', ref('guest'))
const isAdmin = computed(() => userRole.value === 'admin')

const entries = ref<KnowledgeEntry[]>([])
const expandedDocs = ref<Record<string, boolean>>({})
const menuFor = ref('')
const selectedId = ref(localStorage.getItem('ikit-kb-selected') ?? '')
const notice = ref('')
const busy = ref(false)

// 拖拽
const dragId = ref('')
const overId = ref('')
const overPos = ref<'top' | 'middle' | 'bottom'>('middle')

// 移动到…
const moveFor = ref('')
const movePickMode = ref(false)
const moveTargetParent = ref<string | ''>('')

// 权限设置
const permEntry = ref<KnowledgeEntry | null>(null)
const groups = ref<Group[]>([])

// ---- 批量模式（仅站主） ----
// 选择语义：选中集合恒为「反链」（祖先已选时子孙不入集合，显示为「随父级处理」并禁止单独勾选），
// 因此 N 项 = N 个根，不会重复计数；退出批量模式自动清空选择。
const batchMode = ref(false)
const selected = ref<Set<string>>(new Set())
/** 「全选本层」的层级：最近一次勾选节点的 parentId（null = 顶层），默认顶层 */
const batchLevel = ref<string | null>(null)
const batchIds = ref<string[]>([])
const batchMoveOpen = ref(false)
const batchDeleteOpen = ref(false)

function sortList(list: KnowledgeEntry[]): KnowledgeEntry[] {
  return [...list].sort(
    (a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
}

// 受分类/标签筛选后的可见条目
const visible = computed(() =>
  entries.value.filter(
    (e) =>
      !e.deletedAt &&
      (!props.category || (e.category || '') === props.category) &&
      (!props.tag || e.tags.includes(props.tag)),
  ),
)

// 根节点 = 无父 **或** 父不可见（草稿/私有父容器的可见子项不再成为孤儿被丢掉，方案 F6）
const roots = computed(() => {
  const byId = new Set(visible.value.map((e) => e.id))
  return sortList(visible.value.filter((e) => !e.parentId || !byId.has(e.parentId)))
})

function childrenOf(id: string): KnowledgeEntry[] {
  return sortList(visible.value.filter((e) => e.parentId === id))
}

function buildNode(e: KnowledgeEntry): DocNode {
  return { entry: e, children: childrenOf(e.id).map(buildNode) }
}

const docNodes = computed<DocNode[]>(() => roots.value.map(buildNode))

const totalWords = computed(() => visible.value.reduce((s, e) => s + (e.content?.length ?? 0), 0))

function highlight(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 展开目标文档及其全部祖先，并滚动定位到该行（仅首轮加载执行）
function locateTargets() {
  if (located) return
  const ids = props.expandIds ?? []
  if (!ids.length) return
  const byId = new Map(entries.value.map((e) => [e.id, e]))
  let target = ''
  for (const id of ids) {
    if (!byId.has(id)) continue
    if (!target) target = id
    let cur = byId.get(id)
    while (cur) {
      expandedDocs.value = { ...expandedDocs.value, [cur.id]: true }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  if (!target) return
  located = true
  void nextTick(() => {
    treeRef.value?.querySelector(`[data-doc-id="${target}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

async function load() {
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/entries', {
      // 带 token：否则站主也按 guest 过滤，看不到自己的草稿节点（方案 F2）
      headers: authHeaders(),
    })
    entries.value = (r.entries || []).filter((e) => !e.deletedAt)
    // 默认展开所有父节点
    for (const e of entries.value) {
      if (entries.value.some((c) => c.parentId === e.id)) {
        expandedDocs.value = { ...expandedDocs.value, [e.id]: true }
      }
    }
    locateTargets()
  } catch {
    entries.value = []
  }
}

function setNotice(msg: string) {
  notice.value = msg
  if (msg) setTimeout(() => (notice.value = ''), 2500)
}

/** 取服务端明确错误文案（如「不能移动到自身或其子文档下」） */
function errText(e: unknown): string {
  return apiErrorMessage(e)
}

// ---- 选择 / 展开 ----
function onSelect(id: string) {
  const e = entries.value.find((x) => x.id === id)
  if (e) {
    selectedId.value = id
    localStorage.setItem('ikit-kb-selected', id)
    menuFor.value = ''
    emit('open', e)
  }
}
function onToggle(id: string) {
  expandedDocs.value = { ...expandedDocs.value, [id]: !expandedDocs.value[id] }
}
function onMenu(id: string) {
  menuFor.value = menuFor.value === id ? '' : id
}

// ---- 新建子文档 / 编辑 / 置顶 / 删除 ----
function onAddChild(parentId: string) {
  menuFor.value = ''
  emit('createChild', parentId)
}
function onEditEntry(e: KnowledgeEntry) {
  menuFor.value = ''
  emit('edit', e)
}
async function onTogglePin(e: KnowledgeEntry) {
  menuFor.value = ''
  await api(`/api/knowledge/entries/${e.id}/toggle-pin`, { method: 'POST', headers: authHeaders() })
  setNotice(e.pinned ? `已取消置顶「${e.title}」` : `已置顶「${e.title}」`)
  await load()
}
function onPermission(e: KnowledgeEntry) {
  menuFor.value = ''
  permEntry.value = e
}
function onPermSaved() {
  permEntry.value = null
  setNotice('权限已更新')
  load()
}
async function onDelete(e: KnowledgeEntry) {
  menuFor.value = ''
  if (!confirm(`确认删除「${e.title}」？将移入回收站。`)) return
  try {
    await api(`/api/knowledge/entries/${e.id}`, { method: 'DELETE', headers: authHeaders() })
    selectedId.value = ''
    setNotice(`已删除「${e.title}」`)
    await load()
  } catch (err: any) {
    setNotice(err.message)
  }
}

// ---- 批量模式（仅站主）：选择 / 全选本层 / 清空 / 退出 ----
/** 某节点的全部子孙 id（含多层，按当前已加载的未删除条目） */
function descendantsOf(id: string): Set<string> {
  const out = new Set<string>()
  const queue = entries.value.filter((e) => e.parentId === id)
  while (queue.length) {
    const cur = queue.shift()!
    if (out.has(cur.id)) continue
    out.add(cur.id)
    queue.push(...entries.value.filter((e) => e.parentId === cur.id))
  }
  return out
}

/** 随父级处理：已被选中节点的全部子孙（禁用单独勾选，避免重复计数） */
const cascadeIds = computed(() => {
  const out = new Set<string>()
  for (const id of selected.value) for (const d of descendantsOf(id)) out.add(d)
  return out
})

/** 「全选本层」的层级展示（用于按钮 title） */
const batchLevelLabel = computed(() => {
  const parts: string[] = []
  const seen = new Set<string>()
  let curId: string | undefined = batchLevel.value ?? undefined
  while (curId && !seen.has(curId)) {
    seen.add(curId)
    const node = entries.value.find((e) => e.id === curId)
    if (!node) break
    parts.unshift(node.title)
    curId = node.parentId
  }
  return parts.length ? `顶层 / ${parts.join(' / ')}` : '顶层'
})

function toggleBatch() {
  if (batchMode.value) exitBatch()
  else {
    exitMove() // 批量模式与「移动到…点选模式」互斥
    batchMode.value = true
    selected.value = new Set()
    batchLevel.value = null
    menuFor.value = ''
  }
}
/** 退出批量模式：自动清空选择并关闭弹窗（日常不显示复选框） */
function exitBatch() {
  batchMode.value = false
  selected.value = new Set()
  batchLevel.value = null
  batchIds.value = []
  batchMoveOpen.value = false
  batchDeleteOpen.value = false
  menuFor.value = ''
}
function clearSelection() {
  selected.value = new Set()
}
function onToggleSelect(id: string) {
  if (!batchMode.value) return
  if (cascadeIds.value.has(id)) return // 随父级处理：禁止单独勾选
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else {
    next.add(id)
    // 父级覆盖子级：已选的子孙从集合移除（显示为「随父级处理」，不重复计数）
    for (const d of descendantsOf(id)) next.delete(d)
  }
  selected.value = next
  batchLevel.value = entries.value.find((e) => e.id === id)?.parentId ?? null
}
/** 全选本层 = 当前层级的可见兄弟节点（随父级处理的节点不入选集） */
function selectAllInLevel() {
  const level = batchLevel.value
  const next = new Set(selected.value)
  for (const e of visible.value) {
    if ((e.parentId ?? null) !== level) continue
    if (cascadeIds.value.has(e.id)) continue
    next.add(e.id)
  }
  selected.value = next
}
function openBatchMove() {
  if (!selected.value.size) return
  batchIds.value = [...selected.value]
  batchMoveOpen.value = true
}
function openBatchDelete() {
  if (!selected.value.size) return
  batchIds.value = [...selected.value]
  batchDeleteOpen.value = true
}
/** 批量移动成功：清选择 / 退出批量模式，刷新目录树并请父组件刷新卡片流 + 右栏 */
async function onBatchMoved(p: { moved: number; label: string }) {
  const msg = `已移动 ${p.moved} 项到「${p.label}」`
  batchMoveOpen.value = false
  exitBatch()
  await load()
  emit('changed', { message: msg })
}
/** 批量删除成功：级联软删除已在服务端完成，这里同步本地选中态与视图 */
async function onBatchDeleted(p: { deleted: number; affectedIds: string[] }) {
  const msg = `已删除 ${p.affectedIds.length} 篇（${p.deleted} 个根目录，含子文档，可在回收站恢复）`
  batchDeleteOpen.value = false
  if (p.affectedIds.includes(selectedId.value)) selectedId.value = ''
  exitBatch()
  await load()
  emit('changed', { message: msg })
}

// ---- 移动到…（点选目标行） ----
function onPickMoveTarget(id: string) {
  // 已在「移动到…」选择模式：点击行视为选择目标
  if (movePickMode.value && moveFor.value) {
    onPickTarget(id)
    return
  }
  menuFor.value = ''
  moveFor.value = id
  movePickMode.value = true
  moveTargetParent.value = ''
}
function isForbiddenTarget(targetId: string | '', id: string): boolean {
  if (targetId === id) return true
  const idSet = new Set<string>([id])
  const walk = (nodeId: string) => {
    for (const c of entries.value.filter((e) => e.parentId === nodeId)) {
      idSet.add(c.id)
      walk(c.id)
    }
  }
  walk(id)
  return !!targetId && idSet.has(targetId)
}
async function onPickTarget(targetId: string) {
  const id = moveFor.value
  if (!id) return
  if (isForbiddenTarget(targetId, id)) {
    setNotice('不能移动到自身或其子文档下')
    return
  }
  const name = entries.value.find((e) => e.id === id)?.title ?? ''
  try {
    // 服务端同样做环校验（前端提示仅为提前反馈）
    await api(`/api/knowledge/entries/${id}/move`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ parentId: targetId || null }),
    })
    setNotice(`已移动「${name}」`)
    exitMove()
    await load()
  } catch (e: any) {
    setNotice(errText(e))
  }
}
async function onMoveToRoot() {
  const id = moveFor.value
  if (!id) return
  const name = entries.value.find((e) => e.id === id)?.title || ''
  try {
    await api(`/api/knowledge/entries/${id}/move`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ parentId: null }),
    })
    setNotice(`已移动「${name}」到根目录`)
    exitMove()
    await load()
  } catch (e: any) {
    setNotice(errText(e))
  }
}
function exitMove() {
  moveFor.value = ''
  movePickMode.value = false
  moveTargetParent.value = ''
}

// ---- 拖拽排序 / 移动 ----
function onDragStart(id: string) {
  dragId.value = id
  menuFor.value = ''
}
function onDragOver(id: string, pos: 'top' | 'middle' | 'bottom') {
  if (id !== dragId.value) {
    overId.value = id
    overPos.value = pos
  }
}
function onDragEnd() {
  dragId.value = ''
  overId.value = ''
  overPos.value = 'middle'
}
async function moveDoc(id: string, parentId: string | '') {
  await api(`/api/knowledge/entries/${id}/move`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ parentId: parentId || null }),
  })
}
async function onDrop(targetId: string, pos: 'top' | 'middle' | 'bottom') {
  const dragged = dragId.value
  onDragEnd()
  if (!dragged || dragged === targetId) return
  if (isForbiddenTarget(targetId, dragged)) {
    setNotice('不能移动到自身或其子文档下')
    return
  }
  busy.value = true
  try {
    if (pos === 'middle') {
      await moveDoc(dragged, targetId)
    } else {
      let pid = (entries.value.find((e) => e.id === targetId)?.parentId ?? '') as string | ''
      const draggedEntry = entries.value.find((e) => e.id === dragged)
      if ((draggedEntry?.parentId || undefined) !== (pid || undefined)) {
        await moveDoc(dragged, pid)
      }
      const siblings = entries.value
        .filter((e) => !e.deletedAt && (e.parentId || undefined) === (pid || undefined))
        .sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9))
        .map((e) => e.id)
      const fromIdx = siblings.indexOf(dragged)
      const toIdx = siblings.indexOf(targetId)
      if (fromIdx < 0 || toIdx < 0) {
        await load()
        return
      }
      siblings.splice(fromIdx, 1)
      const insertAt = siblings.indexOf(targetId)
      siblings.splice(pos === 'top' ? insertAt : insertAt + 1, 0, dragged)
      await api('/api/knowledge/reorder', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ parentId: pid || null, ids: siblings }),
      })
    }
    setNotice('目录已调整')
    await load()
  } catch (e: any) {
    setNotice(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  load()
  listGroups()
    .then((r) => (groups.value = r.groups))
    .catch(() => {})
})
</script>

<template>
  <div ref="treeRef" class="doc-tree">
    <div class="dt-head">
      <span class="dt-title">目录</span>
      <span class="dt-meta">{{ visible.length }} 篇 · {{ Math.round(totalWords / 1000) }}k 字</span>
      <!-- 批量模式切换（仅站主） -->
      <button v-if="isAdmin && !batchMode" class="batch-toggle" title="批量删除 / 批量移动" @click="toggleBatch">
        ☑ 批量
      </button>
    </div>

    <!-- 批量工具条（仅站主，进入批量模式后显示） -->
    <div v-if="isAdmin && batchMode" class="batch-bar">
      <span class="bb-count">已选 {{ selected.size }} 项</span>
      <button class="batch-btn ghost" :title="`全选本层：${batchLevelLabel}`" @click="selectAllInLevel">
        全选本层
      </button>
      <button class="batch-btn ghost" :disabled="!selected.size" @click="clearSelection">清空</button>
      <button class="batch-btn" :disabled="!selected.size" @click="openBatchMove">批量移动</button>
      <button class="batch-btn danger" :disabled="!selected.size" @click="openBatchDelete">批量删除</button>
      <button class="batch-btn ghost" @click="exitBatch">退出</button>
    </div>
    <div v-if="props.category || props.tag" class="dt-filter">
      筛选：{{ props.category ? '分类 ' + props.category : '' }}{{ props.category && props.tag ? ' · ' : '' }}{{ props.tag ? '标签 ' + props.tag : '' }}
    </div>

    <!-- 移动到… 提示条（站主） -->
    <div v-if="movePickMode" class="move-bar">
      <span>移动「{{ entries.find((e) => e.id === moveFor)?.title }}」到：点击下方目录行</span>
      <button class="mv-btn" @click="onMoveToRoot">移动到根目录</button>
      <button class="mv-btn ghost" @click="exitMove">取消</button>
    </div>
    <div v-if="notice" class="dt-notice">{{ notice }}</div>

    <div v-if="!docNodes.length" class="dt-empty">暂无文章</div>
    <div class="dt-list">
      <DocTreeItem
        v-for="n in docNodes"
        :key="n.entry.id"
        :node="n"
        :depth="0"
        :selected-id="selectedId"
        :batch-mode="batchMode"
        :batch-selected="selected"
        :batch-cascade="cascadeIds"
        :search-q="''"
        :expanded-docs="expandedDocs"
        :menu-for="menuFor"
        :highlight="highlight"
        :drag-id="dragId"
        :over-id="overId"
        :over-pos="overPos"
        :move-picker-for="moveFor"
        :move-target-parent="moveTargetParent"
        :forbidden="movePickMode && isForbiddenTarget(moveTargetParent, moveFor)"
        :move-pick-mode="movePickMode"
        :admin="isAdmin"
        @select="onSelect"
        @toggle="onToggle"
        @menu="onMenu"
        @add-child="onAddChild"
        @drag-start="onDragStart"
        @drag-over="onDragOver"
        @drop="onDrop"
        @drag-end="onDragEnd"
        @pick-move-target="onPickMoveTarget"
        @toggle-select="onToggleSelect"
      >
        <!-- 菜单条目：当前展开的条目 id = menuFor（条目菜单仅在其 menuFor 命中时渲染） -->
        <template #entry-menu>
          <div class="doc-menu-item" @click="onEditEntry(entries.find((e) => e.id === menuFor)!)">✏️ 编辑</div>
          <div class="doc-menu-item" @click="onTogglePin(entries.find((e) => e.id === menuFor)!)">
            {{ entries.find((e) => e.id === menuFor)?.pinned ? '📌 取消置顶' : '📌 置顶' }}
          </div>
          <div class="doc-menu-item" @click="onPermission(entries.find((e) => e.id === menuFor)!)">🔒 权限设置</div>
          <div class="doc-menu-item danger" @click="onDelete(entries.find((e) => e.id === menuFor)!)">🗑 删除</div>
        </template>
      </DocTreeItem>
    </div>

    <EntryPermissionDialog
      v-if="permEntry"
      :entry="permEntry"
      :groups="groups"
      @saved="onPermSaved"
      @close="permEntry = null"
    />

    <!-- 批量移动（可搜索层级下拉，含「顶层」）/ 批量删除（级联软删除确认） -->
    <BatchMoveDialog
      v-if="batchMoveOpen"
      :ids="batchIds"
      @close="batchMoveOpen = false"
      @moved="onBatchMoved"
    />
    <BatchDeleteDialog
      v-if="batchDeleteOpen"
      :ids="batchIds"
      :entries="entries"
      @close="batchDeleteOpen = false"
      @deleted="onBatchDeleted"
    />
  </div>
</template>

<style scoped>
.doc-tree { padding: 0 2px; }
.dt-head { display: flex; align-items: baseline; gap: 6px; justify-content: space-between; margin-bottom: 6px; padding: 0 6px; }
.dt-title { font-size: 12px; font-weight: 700; color: var(--text); }
.dt-meta { font-size: 11px; color: var(--muted); }
.dt-empty { font-size: 12px; color: var(--muted); padding: 8px 10px; }
.dt-list { display: flex; flex-direction: column; gap: 1px; }
.dt-notice { font-size: 12px; color: var(--ok); padding: 4px 8px; }
.dt-filter { font-size: 11px; color: var(--primary-dark); background: var(--primary-soft); border-radius: 6px; padding: 4px 8px; margin-bottom: 6px; }
/* 批量模式（仅站主）：切换按钮 + 工具条（与卡片流「批量管理」同一套视觉语言） */
.batch-toggle {
  border: 1px dashed var(--primary); background: transparent; color: var(--primary-dark);
  border-radius: 8px; padding: 2px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.batch-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  border: 1px solid var(--primary); background: var(--primary-soft);
  border-radius: 8px; padding: 6px 8px; margin-bottom: 8px;
}
.bb-count { font-size: 12px; font-weight: 700; color: var(--primary-dark); }
.batch-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.batch-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.batch-btn.danger { border-color: var(--danger); background: var(--danger); }
.batch-btn:disabled { opacity: 0.5; cursor: default; }
.move-bar {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--primary-soft); border: 1px solid var(--primary);
  border-radius: 8px; padding: 8px 10px; margin-bottom: 8px;
  font-size: 12px; color: var(--primary-dark);
}
.mv-btn { border: 1px solid var(--primary); background: var(--primary); color: #fff; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
.mv-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
</style>
