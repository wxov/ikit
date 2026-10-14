<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type CategoryNode, type EntryVisibility, type KnowledgeEntry } from '../lib/api'
import { authHeaders, listGroups, type Group } from '../lib/auth'
import DocParentPicker from './DocParentPicker.vue'

// 批量导入文档（站主）：本地解析 .md/.markdown → POST /api/knowledge/import
// 支持选择「导入到」的父文档（可搜索层级下拉，默认顶层）与新建父文档（标题/分类/可见性）
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'imported', payload: { count: number; parentId?: string }): void
}>()

// 与服务端 MAX_IMPORT_ENTRIES 一致（超出先在前端拦截，避免白跑一趟请求）
const MAX_ENTRIES = 500

interface ImportItem {
  title: string
  content: string
  tags: string[]
  category?: string
}

// 文档列表条目（列表接口只返回未删除条目，deletedAt 仅作前端兜底过滤）
type DocEntry = KnowledgeEntry & { deletedAt?: string }

const VIS_OPTIONS: { key: EntryVisibility; label: string; hint: string }[] = [
  { key: 'public', label: '公开', hint: '所有人（含游客）可见' },
  { key: 'login', label: '仅登录用户', hint: '所有登录用户可见' },
  { key: 'groups', label: '指定组', hint: '仅选中的用户组可见' },
  { key: 'private', label: '仅站主', hint: '只有站主可见' },
]

const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const progress = ref('')
const error = ref('')
const result = ref('')

// ---- 导入到：父文档选择 ----
// 下拉本体（含「顶层」/搜索/清空）已抽为公共组件 `DocParentPicker.vue`（批量移动目标复用同一组件）；
// 本组件只保留「完整路径」计算（供选择器候选与结果文案）与新建父文档子表单。
const parentId = ref('')
const allDocs = ref<DocEntry[]>([])
const docById = computed(() => new Map(allDocs.value.map((e) => [e.id, e])))
/** 由 parentId 关系回溯出完整路径标签，如 `技术笔记 / Vue / 组件` */
function pathOf(id: string): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let cur = docById.value.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    parts.unshift(cur.title)
    cur = cur.parentId ? docById.value.get(cur.parentId) : undefined
  }
  return parts.join(' / ')
}
const docOptions = computed(() =>
  allDocs.value
    .map((e) => ({ id: e.id, path: pathOf(e.id) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh')),
)
const parentLabel = computed(() =>
  parentId.value ? pathOf(parentId.value) || '已选父文档' : '顶层（无父文档）',
)

// ---- ＋ 新建父文档 ----
const newOpen = ref(false)
const npTitle = ref('')
const npCategory = ref('')
const npVisibility = ref<EntryVisibility>('public')
const npGroups = ref<string[]>([])
const groups = ref<Group[]>([])
const catPaths = ref<string[]>([])
const creating = ref(false)
const createError = ref('')
const createNotice = ref('')

async function loadDocs() {
  try {
    // 带站主 token：可见性过滤按站主视角（否则只会列出 public 文档，无法选到 private/groups 父档）
    const r = await api<{ entries: DocEntry[] }>('/api/knowledge/entries?limit=1000', {
      headers: authHeaders(),
    })
    allDocs.value = (r.entries ?? []).filter((e) => !e.deletedAt)
  } catch {
    allDocs.value = []
  }
}
async function loadCatPaths() {
  try {
    const r = await api<{ categories: CategoryNode[] }>('/api/knowledge/categories', {
      headers: authHeaders(),
    })
    const out: string[] = []
    const walk = (nodes: CategoryNode[]) => {
      for (const n of nodes) {
        out.push(n.path)
        if (n.children?.length) walk(n.children)
      }
    }
    walk(r.categories ?? [])
    catPaths.value = out
  } catch {
    catPaths.value = []
  }
}
/** 选「指定组」时才拉取用户组（按需，失败静默） */
async function ensureGroups() {
  if (groups.value.length) return
  try {
    groups.value = (await listGroups()).groups ?? []
  } catch {
    groups.value = []
  }
}

async function createParent() {
  createError.value = ''
  createNotice.value = ''
  if (!npTitle.value.trim()) {
    createError.value = '请填写父文档标题'
    return
  }
  if (npVisibility.value === 'groups' && !npGroups.value.length) {
    createError.value = '可见性为「指定组」时请至少勾选一个用户组'
    return
  }
  creating.value = true
  try {
    const parentTitle = npTitle.value.trim()
    const r = await api<{ entry: KnowledgeEntry }>('/api/knowledge/entries', {
      method: 'POST',
      headers: authHeaders(),
      // 新建的父文档只作挂载容器：`status:'published'` 走与 PATCH 一致的发布校验（标题 + 正文非空白），
      // 因此正文用一级标题占位（非空白、渲染即标题本身），不能用空白字符串。
      // status: 'published' —— 父容器必须对游客可见，否则其下 published 子项在左栏目录树成为孤儿（方案 F6）
      body: JSON.stringify({
        title: parentTitle,
        content: `# ${parentTitle}`,
        status: 'published',
        category: npCategory.value.trim() || undefined,
        visibility: npVisibility.value,
        visibleGroups: npVisibility.value === 'groups' ? npGroups.value : undefined,
      }),
    })
    allDocs.value = [...allDocs.value, r.entry]
    if (r.entry.category && !catPaths.value.includes(r.entry.category)) {
      catPaths.value = [...catPaths.value, r.entry.category]
    }
    parentId.value = r.entry.id // 创建成功 → 自动选中为新父级
    newOpen.value = false
    createNotice.value = `已新建父文档「${r.entry.title}」并选中为导入目标`
    npTitle.value = ''
    npCategory.value = ''
    npVisibility.value = 'public'
    npGroups.value = []
  } catch (e) {
    createError.value = errMessage(e)
  } finally {
    creating.value = false
  }
}

function triggerFile() {
  if (!busy.value) fileInput.value?.click()
}
function triggerDir() {
  if (!busy.value) dirInput.value?.click()
}

/** 首行 `# 标题` 作标题、其余作正文；否则文件名（去扩展名）作标题、全文作正文 */
function parseMarkdown(filename: string, content: string) {
  const lines = content.split(/\r?\n/)
  const heading = lines[0]?.trim().match(/^#\s+(.+)$/)
  if (heading) return { title: heading[1].trim(), content: lines.slice(1).join('\n').trim() }
  return { title: filename.replace(/\.(md|markdown)$/i, ''), content: content.trim() }
}

/** 由文件推导条目：子目录 → 分类路径（如 `技术/前端`），仅顶层目录 → tags */
function toItem(f: File, content: string): ImportItem {
  const { title, content: body } = parseMarkdown(f.name, content)
  const tags: string[] = []
  let category: string | undefined
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
  if (rel && rel.includes('/')) {
    const parts = rel.split('/')
    const topDir = parts[0]
    const subDirs = parts.slice(1, -1)
    if (subDirs.length) category = subDirs.join('/')
    else if (topDir) tags.push(topDir)
  }
  return { title, content: body, tags, category }
}

/** 读取错误响应（api() 抛出的 message 为响应原文，尽量取出其中的 error 文案） */
function errMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  try {
    const j = JSON.parse(raw) as { error?: string }
    if (j?.error) return j.error
  } catch {
    /* 非 JSON：原样展示 */
  }
  return raw
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 允许连续选择同一批文件
  error.value = ''
  result.value = ''
  createNotice.value = ''
  const mdFiles = files.filter((f) => /\.(md|markdown)$/i.test(f.name))
  if (!mdFiles.length) {
    error.value = '未找到 .md / .markdown 文件'
    return
  }
  if (mdFiles.length > MAX_ENTRIES) {
    error.value = `单次最多导入 ${MAX_ENTRIES} 个文件（本次选中 ${mdFiles.length} 个）`
    return
  }

  busy.value = true
  const targetId = parentId.value
  const targetLabel = parentLabel.value
  try {
    const items: ImportItem[] = []
    for (let i = 0; i < mdFiles.length; i++) {
      progress.value = `正在解析 ${i + 1}/${mdFiles.length} …`
      items.push(toItem(mdFiles[i], await mdFiles[i].text()))
    }
    progress.value = `正在上传 ${items.length} 个条目 …`
    const r = await api<{ created: number; entries: Array<{ title: string }> }>(
      '/api/knowledge/import',
      {
        method: 'POST',
        headers: authHeaders(),
        // 统一父级：条目不带 parentId（保留后端逐条覆盖能力）
        body: JSON.stringify(targetId ? { entries: items, parentId: targetId } : { entries: items }),
      },
    )
    const skipped = items.length - r.created
    result.value = `成功导入 ${r.created} 条${skipped > 0 ? `（跳过 ${skipped} 条无标题）` : ''} → 挂载到「${targetLabel}」`
    emit('imported', { count: r.created, parentId: targetId || undefined })
  } catch (err) {
    error.value = errMessage(err)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

function close() {
  if (!busy.value) emit('close')
}

onMounted(() => {
  loadDocs()
  loadCatPaths()
})
</script>

<template>
  <div class="imp-overlay" @click.self="close">
    <div class="imp-modal">
      <h3>📥 批量导入文档</h3>
      <p class="imp-hint">
        支持 Markdown（.md / .markdown）。首行 <code># 标题</code> 作为文章标题，否则用文件名；
        文件夹导入时子目录作为分类路径、顶层目录作为标签。单次最多 {{ MAX_ENTRIES }} 个文件。
        未指定分类的条目在指定父文档时继承父文档分类，未指定可见性时继承父文档可见性。
      </p>

      <!-- 导入到：父文档（可搜索层级下拉，公共组件；行为与样式与抽取前一致） -->
      <DocParentPicker v-model="parentId" :docs="docOptions" label="导入到" :disabled="busy">
        <template #actions>
          <button class="imp-btn ghost sm" :disabled="busy" @click="newOpen = !newOpen; createNotice = ''">
            ＋ 新建父文档
          </button>
        </template>
        <!-- 新建父文档子表单（默认插槽：与选择器同处一个边框卡片内，观感与抽取前一致） -->
        <div v-if="newOpen" class="imp-new">
          <div class="imp-new-row">
            <label class="imp-new-label">标题 *</label>
            <input v-model="npTitle" class="imp-input" placeholder="父文档标题" />
          </div>
          <div class="imp-new-row">
            <label class="imp-new-label">分类</label>
            <input
              v-model="npCategory"
              class="imp-input"
              list="imp-cats"
              placeholder="如：技术笔记/Vue（可留空）"
            />
            <datalist id="imp-cats">
              <option v-for="c in catPaths" :key="c" :value="c" />
            </datalist>
          </div>
          <div class="imp-new-row col">
            <label class="imp-new-label">可见性</label>
            <div class="imp-levels">
              <label
                v-for="o in VIS_OPTIONS"
                :key="o.key"
                class="imp-level"
                :class="{ on: npVisibility === o.key }"
              >
                <input
                  type="radio"
                  v-model="npVisibility"
                  :value="o.key"
                  @change="o.key === 'groups' && ensureGroups()"
                />
                <span class="pl-name">{{ o.label }}</span>
                <span class="pl-hint">{{ o.hint }}</span>
              </label>
            </div>
          </div>
          <div v-if="npVisibility === 'groups'" class="imp-new-row col">
            <label class="imp-new-label">可见用户组（可多选）</label>
            <div class="imp-groups">
              <label
                v-for="g in groups"
                :key="g.id"
                class="imp-group"
                :class="{ on: npGroups.includes(g.id) }"
              >
                <input type="checkbox" :value="g.id" v-model="npGroups" />
                {{ g.name }}<i v-if="g.builtin" class="pg-builtin">内置</i>
              </label>
              <span v-if="!groups.length" class="imp-picker-empty">暂无用户组</span>
            </div>
          </div>
          <div class="imp-new-foot">
            <button class="imp-btn sm" :disabled="creating || busy" @click="createParent">
              {{ creating ? '创建中…' : '创建并选中' }}
            </button>
            <button class="imp-btn ghost sm" :disabled="creating" @click="newOpen = false">收起</button>
          </div>
          <div v-if="createError" class="imp-error">❌ 新建父文档失败：{{ createError }}</div>
        </div>
      </DocParentPicker>

      <div class="imp-actions">
        <button class="imp-btn" :disabled="busy" @click="triggerFile">📄 导入文件</button>
        <button class="imp-btn ghost" :disabled="busy" @click="triggerDir">📁 导入文件夹</button>
      </div>

      <div v-if="busy" class="imp-progress">{{ progress || '处理中…' }}</div>
      <div v-if="createNotice" class="imp-result">✅ {{ createNotice }}</div>
      <div v-if="result" class="imp-result">✅ {{ result }}</div>
      <div v-if="error" class="imp-error">❌ {{ error }}</div>

      <div class="imp-foot">
        <button class="imp-btn ghost" :disabled="busy" @click="close">
          {{ result ? '完成' : '取消' }}
        </button>
      </div>

      <!-- 文件多选（仅 md） -->
      <input
        ref="fileInput"
        class="imp-hidden"
        type="file"
        accept=".md,.markdown"
        multiple
        @change="onPick"
      />
      <!-- 文件夹选择（webkitdirectory 由浏览器展开整目录，含相对路径） -->
      <input ref="dirInput" class="imp-hidden" type="file" webkitdirectory multiple @change="onPick" />
    </div>
  </div>
</template>

<style scoped>
.imp-overlay {
  position: fixed; inset: 0; z-index: 520;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.imp-modal {
  width: min(560px, 96vw);
  max-height: 88vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px;
}
.imp-modal h3 { margin: 0 0 6px; }
.imp-hint { margin: 0 0 14px; font-size: 12px; color: var(--muted); line-height: 1.7; }
.imp-hint code {
  background: var(--primary-soft); color: var(--primary-dark);
  border-radius: 4px; padding: 0 4px; font-size: 12px;
}
/* ---- 导入到 ---- */
/* 下拉本体（.dpp-*）已随公共组件 `DocParentPicker.vue` 抽取；此处仅保留本弹窗自用的提示样式 */
.imp-picker-empty { font-size: 12px; color: var(--muted); padding: 6px 8px; }
/* ---- 新建父文档 ---- */
.imp-new {
  margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border);
  display: flex; flex-direction: column; gap: 8px;
}
.imp-new-row { display: flex; align-items: center; gap: 8px; }
.imp-new-row.col { flex-direction: column; align-items: stretch; gap: 4px; }
.imp-new-label { font-size: 12px; color: var(--muted); flex: 0 0 62px; }
.imp-input {
  flex: 1; border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 6px 8px; font-size: 13px; font-family: inherit;
}
.imp-levels { display: flex; flex-direction: column; gap: 4px; }
.imp-level {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 13px;
}
.imp-level.on { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-dark); }
.imp-level input { accent-color: var(--primary); }
.pl-name { font-weight: 600; }
.pl-hint { font-size: 11px; color: var(--muted); }
.imp-groups { display: flex; flex-wrap: wrap; gap: 6px; }
.imp-group {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 12px;
}
.imp-group.on { background: var(--primary-soft); border-color: var(--primary); }
.imp-group input { accent-color: var(--primary); }
.pg-builtin { font-style: normal; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; }
.imp-new-foot { display: flex; gap: 8px; }
/* ---- 通用 ---- */
.imp-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.imp-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.imp-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.imp-btn.sm { padding: 4px 12px; font-size: 12px; }
.imp-btn:disabled { opacity: 0.6; cursor: default; }
.imp-progress { margin-top: 12px; font-size: 13px; color: var(--muted); }
.imp-result { margin-top: 12px; font-size: 13px; color: var(--ok); }
.imp-error { margin-top: 8px; font-size: 13px; color: var(--danger); word-break: break-word; }
.imp-foot { display: flex; justify-content: flex-end; margin-top: 16px; }
.imp-hidden { display: none; }
</style>
