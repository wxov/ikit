<script setup lang="ts">
import { computed, ref, inject, type Ref } from 'vue'
import { type KnowledgeEntry } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import CommentSection from './CommentSection.vue'

const props = defineProps<{ entry: KnowledgeEntry }>()
const emit = defineEmits<{
  (e: 'back'): void
  (e: 'edit', entry: KnowledgeEntry): void
  (e: 'tag', tag: string): void
  (e: 'publish', entry: KnowledgeEntry): void
}>()

const userRole = inject<Ref<string>>('userRole', ref('guest'))
const canEdit = computed(() => userRole.value === 'admin')
// 草稿（含缺省 status 的存量条目视为已发布）：仅站主可见，故徽标/快捷发布也只对站主显示
const isDraft = computed(() => canEdit.value && (props.entry.status ?? 'published') !== 'published')

const rendered = computed(() => renderMarkdown(props.entry.content).html)

function shortDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
</script>

<template>
  <article class="article-detail">
    <div class="ad-toolbar">
      <button class="ad-back" @click="emit('back')">← 返回列表</button>
      <span class="ad-actions">
        <button v-if="isDraft" class="ad-publish" @click="emit('publish', entry)">发布</button>
        <button v-if="canEdit" class="ad-edit" @click="emit('edit', entry)">✎ 编辑</button>
      </span>
    </div>

    <header class="ad-head">
      <h1 class="ad-title">{{ entry.title }}</h1>
      <div class="ad-meta">
        <span v-if="isDraft" class="ad-status">草稿 · 仅站主可见</span>
        <span class="am"><b>📂</b> {{ entry.category || '未分类' }}</span>
        <span class="am"><b>🕑</b> {{ shortDate(entry.updatedAt) }}</span>
        <span v-if="entry.views" class="am"><b>👁</b> {{ entry.views }}</span>
      </div>
    </header>

    <div class="markdown-body" v-html="rendered"></div>

    <div v-if="entry.tags?.length" class="ad-tags">
      <span v-for="t in entry.tags" :key="t" class="ad-tag" @click="emit('tag', t)"># {{ t }}</span>
    </div>

    <CommentSection :entry-id="entry.id" class="ad-comments" />
  </article>
</template>

<style scoped>
.article-detail { padding: 8px 2px 24px; }
.ad-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.ad-actions { display: flex; align-items: center; gap: 8px; }
.ad-back, .ad-edit, .ad-publish {
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.ad-edit { color: var(--primary-dark); border-color: var(--primary); }
.ad-publish { color: #fff; border-color: var(--ok, #22c55e); background: var(--ok, #22c55e); }
.ad-status {
  font-size: 12px; padding: 3px 10px; border-radius: 999px;
  background: var(--warn-soft, #fef3c7); color: var(--warn, #b45309);
  border: 1px solid var(--warn, #f59e0b);
}
.ad-title { margin: 0 0 8px; font-size: 26px; line-height: 1.3; }
.ad-meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; color: var(--muted); margin-bottom: 14px; }
.am b { font-weight: 400; margin-right: 2px; }
.ad-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.ad-tag {
  font-size: 12px; padding: 4px 12px; border-radius: 999px;
  background: var(--primary-soft); color: var(--primary-dark); cursor: pointer;
}
</style>
