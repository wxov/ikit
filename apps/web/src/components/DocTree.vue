<script setup lang="ts">
import { ref, computed, onMounted, inject, type Ref } from 'vue'
import { api, type KnowledgeEntry } from '../lib/api'
import { authHeaders } from '../lib/auth'
import DocTreeItem, { type DocNode } from './DocTreeItem.vue'

const emit = defineEmits<{
  (e: 'open', entry: KnowledgeEntry): void
  (e: 'edit', entry: KnowledgeEntry): void
  (e: 'createChild', parentId: string): void
}>()

const props = defineProps<{ category?: string; tag?: string }>()

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

const roots = computed(() => sortList(visible.value.filter((e) => !e.parentId)))

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

async function load() {
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/entries')
    entries.value = (r.entries || []).filter((e) => !e.deletedAt)
    // 默认展开所有父节点
    for (const e of entries.value) {
      if (entries.value.some((c) => c.parentId === e.id)) {
        expandedDocs.value = { ...expandedDocs.value, [e.id]: true }
      }
    }
  } catch {
    entries.value = []
  }
}

function setNotice(msg: string) {
  notice.value = msg
  if (msg) setTimeout(() => (notice.value = ''), 2500)
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
  await api(`/api/knowledge/entries/${id}/move`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ parentId: targetId || null }),
  })
  setNotice(`已移动「${name}」`)
  exitMove()
  await load()
}
async function onMoveToRoot() {
  const id = moveFor.value
  if (!id) return
  const name = entries.value.find((e) => e.id === id)?.title ?? ''
  await api(`/api/knowledge/entries/${id}/move`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ parentId: null }),
  })
  setNotice(`已移动「${name}」到根目录`)
  exitMove()
  await load()
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

onMounted(load)
</script>

<template>
  <div class="doc-tree">
    <div class="dt-head">
      <span class="dt-title">目录</span>
      <span class="dt-meta">{{ visible.length }} 篇 · {{ Math.round(totalWords / 1000) }}k 字</span>
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
        :batch-mode="false"
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
      >
        <template #entry-menu="{ id }">
          <div class="doc-menu-item" @click="onEditEntry(entries.find((e) => e.id === id)!)">✏️ 编辑</div>
          <div class="doc-menu-item" @click="onTogglePin(entries.find((e) => e.id === id)!)">
            {{ entries.find((e) => e.id === id)?.pinned ? '📌 取消置顶' : '📌 置顶' }}
          </div>
          <div class="doc-menu-item danger" @click="onDelete(entries.find((e) => e.id === id)!)">🗑 删除</div>
        </template>
      </DocTreeItem>
    </div>
  </div>
</template>

<style scoped>
.doc-tree { padding: 0 2px; }
.dt-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; padding: 0 6px; }
.dt-title { font-size: 12px; font-weight: 700; color: var(--text); }
.dt-meta { font-size: 11px; color: var(--muted); }
.dt-empty { font-size: 12px; color: var(--muted); padding: 8px 10px; }
.dt-list { display: flex; flex-direction: column; gap: 1px; }
.dt-notice { font-size: 12px; color: var(--ok); padding: 4px 8px; }
.dt-filter { font-size: 11px; color: var(--primary-dark); background: var(--primary-soft); border-radius: 6px; padding: 4px 8px; margin-bottom: 6px; }
.move-bar {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--primary-soft); border: 1px solid var(--primary);
  border-radius: 8px; padding: 8px 10px; margin-bottom: 8px;
  font-size: 12px; color: var(--primary-dark);
}
.mv-btn { border: 1px solid var(--primary); background: var(--primary); color: #fff; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
.mv-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
</style>
