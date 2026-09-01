<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { api, type KnowledgeEntry } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { authHeaders } from '../lib/auth'

const props = defineProps<{ entry?: KnowledgeEntry | null; categories?: string[]; parentId?: string }>()
const emit = defineEmits<{
  (e: 'saved', entry: KnowledgeEntry): void
  (e: 'cancel'): void
}>()

const isNew = computed(() => !props.entry)
const title = ref('')
const cover = ref('')
const category = ref('')
const tags = ref('')
const content = ref('')
const tab = ref<'write' | 'preview'>('write')
const busy = ref(false)
const error = ref('')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function onFilePick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    error.value = '仅支持图片文件'
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    error.value = '图片过大（最大 5MB）'
    return
  }
  uploading.value = true
  error.value = ''
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('读取文件失败'))
      r.readAsDataURL(file)
    })
    const r = await api<{ url: string }>('/api/upload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: file.name, data: dataUrl }),
    })
    cover.value = r.url
  } catch (e: any) {
    error.value = e.message
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

watch(
  () => props.entry,
  (e) => {
    title.value = e?.title ?? ''
    cover.value = e?.cover ?? ''
    category.value = e?.category ?? ''
    tags.value = (e?.tags ?? []).join(', ')
    content.value = e?.content ?? ''
    error.value = ''
  },
  { immediate: true },
)

const previewHtml = computed(() => renderMarkdown(content.value).html)
const catPaths = computed(() => props.categories ?? [])

async function save() {
  error.value = ''
  if (!title.value.trim() || !content.value.trim()) {
    error.value = '标题和内容不能为空'
    return
  }
  busy.value = true
  try {
    const payload = {
      title: title.value.trim(),
      content: content.value,
      cover: cover.value.trim() || undefined,
      category: category.value.trim() || undefined,
      tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean),
    }
    let r: { entry: KnowledgeEntry }
    if (isNew.value) {
      r = await api<{ entry: KnowledgeEntry }>('/api/knowledge/entries', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...payload, parentId: props.parentId || undefined }),
      })
    } else {
      r = await api<{ entry: KnowledgeEntry }>(`/api/knowledge/entries/${props.entry!.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      })
    }
    emit('saved', r.entry)
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!props.entry) return
  if (!confirm(`确认删除「${props.entry.title}」？此操作将移入回收站。`)) return
  busy.value = true
  error.value = ''
  try {
    await api(`/api/knowledge/entries/${props.entry.id}`, { method: 'DELETE', headers: authHeaders() })
    emit('saved', null as any)
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="editor-overlay" @click.self="emit('cancel')">
    <div class="editor-panel">
      <header class="ed-head">
        <h3>{{ isNew ? '新建文章' : '编辑文章' }}</h3>
        <button class="ed-x" title="关闭" @click="emit('cancel')">×</button>
      </header>

      <div v-if="error" class="ed-error">{{ error }}</div>

      <div class="ed-field">
        <label>标题</label>
        <input v-model="title" class="ed-input" placeholder="文章标题" />
      </div>

      <div class="ed-row">
        <div class="ed-field">
          <label>分类（路径）</label>
          <input v-model="category" class="ed-input" list="ed-cats" placeholder="如：技术/后端" />
          <datalist id="ed-cats">
            <option v-for="c in catPaths" :key="c" :value="c" />
          </datalist>
        </div>
        <div class="ed-field">
          <label>封面图 URL（可选）</label>
          <div class="ed-cover-row">
            <input v-model="cover" class="ed-input" placeholder="https://…/cover.png 或点击右侧上传" />
            <button class="ed-btn ghost sm" :disabled="uploading" @click="fileInput?.click()">
              {{ uploading ? '上传中…' : '📤 上传图片' }}
            </button>
            <input ref="fileInput" type="file" accept="image/*" hidden @change="onFilePick" />
          </div>
          <div v-if="cover" class="ed-cover-preview">
            <img :src="cover" alt="封面预览" />
            <span class="ed-cover-hint">封面预览（存储于 /uploads）</span>
          </div>
        </div>
      </div>

      <div class="ed-field">
        <label>标签（逗号分隔）</label>
        <input v-model="tags" class="ed-input" placeholder="ai, 教程, 笔记" />
      </div>

      <div class="ed-editor">
        <div class="ed-tabs">
          <button :class="{ on: tab === 'write' }" @click="tab = 'write'">编写</button>
          <button :class="{ on: tab === 'preview' }" @click="tab = 'preview'">预览</button>
        </div>
        <textarea
          v-if="tab === 'write'"
          v-model="content"
          class="ed-content"
          placeholder="支持 Markdown 语法…"
        />
        <div v-else class="ed-preview markdown-body" v-html="previewHtml"></div>
      </div>

      <footer class="ed-foot">
        <button v-if="!isNew" class="ed-btn danger" :disabled="busy" @click="remove">删除</button>
        <span class="ed-spacer" />
        <button class="ed-btn ghost" @click="emit('cancel')">取消</button>
        <button class="ed-btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.editor-overlay {
  position: fixed; inset: 0; z-index: 700;
  background: rgba(15, 23, 42, 0.5);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 20px; overflow-y: auto;
}
.editor-panel {
  width: 860px; max-width: 100%;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  padding: 20px 24px; display: flex; flex-direction: column; gap: 12px;
  margin: auto;
}
.ed-head { display: flex; align-items: center; justify-content: space-between; }
.ed-head h3 { margin: 0; }
.ed-x { border: none; background: transparent; color: var(--muted); font-size: 24px; cursor: pointer; line-height: 1; }
.ed-error { font-size: 13px; color: var(--danger); }
.ed-field { display: flex; flex-direction: column; gap: 4px; }
.ed-field label { font-size: 12px; color: var(--muted); }
.ed-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ed-input {
  width: 100%; padding: 9px 12px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 14px; font-family: inherit; background: var(--bg); color: var(--text);
}
.ed-cover-row { display: flex; gap: 8px; align-items: center; }
.ed-cover-row .ed-input { flex: 1; }
.ed-btn.sm { padding: 7px 12px; font-size: 12px; }
.ed-cover-preview { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.ed-cover-preview img { height: 64px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover; }
.ed-cover-hint { font-size: 11px; color: var(--muted); }
.ed-editor { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.ed-tabs { display: flex; gap: 2px; padding: 6px; background: var(--bg); border-bottom: 1px solid var(--border); }
.ed-tabs button { border: none; background: transparent; padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; color: var(--muted); font-family: inherit; }
.ed-tabs button.on { background: var(--primary-soft); color: var(--primary-dark); font-weight: 600; }
.ed-content { width: 100%; min-height: 320px; border: none; outline: none; padding: 14px 16px; font-size: 14px; line-height: 1.7; font-family: inherit; background: var(--panel); color: var(--text); resize: vertical; }
.ed-preview { min-height: 320px; padding: 14px 16px; }
.ed-foot { display: flex; align-items: center; gap: 8px; }
.ed-spacer { flex: 1; }
.ed-btn { border: 1px solid var(--border); border-radius: 8px; padding: 8px 18px; font-size: 13px; cursor: pointer; font-family: inherit; }
.ed-btn.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.ed-btn.ghost { background: var(--panel); color: var(--text); }
.ed-btn.danger { color: var(--danger); border-color: var(--danger); background: var(--panel); }
.ed-btn:disabled { opacity: 0.6; cursor: default; }
@media (max-width: 640px) {
  .ed-row { grid-template-columns: 1fr; }
}
</style>
