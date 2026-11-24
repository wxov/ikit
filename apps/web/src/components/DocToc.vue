<script setup lang="ts">
import { computed } from 'vue'

// 文档右侧目录（TOC）：阅读端与需要时复用。
// - items 由渲染后的正文标题（h1..h6，含 markdown-it 生成的 heading-N id）提取；
// - 点击 → 父组件负责滚动定位；activeId 由父组件按滚动位置计算（滚动高亮）。
export interface TocItem {
  id: string
  level: number
  text: string
}

const props = defineProps<{
  items: TocItem[]
  activeId?: string
  /** 标题文案（默认「目录」） */
  label?: string
}>()

const emit = defineEmits<{ (e: 'jump', id: string): void }>()

const minLevel = computed(() => (props.items.length ? Math.min(...props.items.map((i) => i.level)) : 1))
</script>

<template>
  <nav class="doc-toc" aria-label="文档目录">
    <div class="dt-head">{{ label || '目录' }}</div>
    <ul class="dt-list">
      <li
        v-for="it in items"
        :key="it.id"
        class="dt-item"
        :class="{ on: it.id === activeId }"
        :style="{ paddingLeft: (it.level - minLevel) * 10 + 'px' }"
      >
        <button class="dt-btn" :title="it.text" @click="emit('jump', it.id)">{{ it.text }}</button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.doc-toc {
  font-size: 12px;
  color: var(--muted);
}
.dt-head {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
  padding-left: 8px;
  border-left: 3px solid var(--primary);
  line-height: 1.2;
}
.dt-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dt-item {
  border-left: 2px solid transparent;
}
.dt-item.on {
  border-left-color: var(--primary);
  background: var(--primary-soft);
  border-radius: 0 6px 6px 0;
}
.dt-btn {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dt-item.on .dt-btn {
  color: var(--primary-dark);
  font-weight: 600;
}
.dt-btn:hover {
  color: var(--primary-dark);
  background: var(--primary-soft);
  border-radius: 0 6px 6px 0;
}
</style>
