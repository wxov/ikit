<script setup lang="ts">
import { ref } from 'vue'
import type { CategoryNode } from '../lib/api'

defineProps<{
  nodes: CategoryNode[]
  activePath: string
  depth?: number
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'remove', path: string): void
  (e: 'rename', path: string): void
}>()

const STORAGE_KEY = 'ikit-cat-expanded'

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

const expanded = ref(loadExpanded())

function toggle(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
}
</script>

<template>
  <div class="cat-tree">
    <div
      v-for="n in nodes"
      :key="n.path"
      class="cat-node"
      :class="{ active: activePath === n.path }"
      :style="{ paddingLeft: 4 + (depth ?? 0) * 14 + 'px' }"
    >
      <div class="cat-row" @click="emit('select', n.path)">
        <span
          class="cat-toggle"
          :class="{ leaf: !n.children.length }"
          @click.stop="n.children.length && toggle(n.path)"
        >
          {{ n.children.length ? (expanded.has(n.path) ? '▾' : '▸') : '' }}
        </span>
        <span class="cat-name">{{ n.name }}</span>
        <span class="cat-count">{{ n.count }}</span>
        <button class="cat-del" title="重命名" @click.stop="emit('rename', n.path)">✎</button>
        <button
          class="cat-del"
          title="删除分类"
          @click.stop="emit('remove', n.path)"
        >
          ×
        </button>
      </div>
      <CategoryTree
        v-if="n.children.length && expanded.has(n.path)"
        :nodes="n.children"
        :active-path="activePath"
        :depth="(depth ?? 0) + 1"
        @select="(p: string) => emit('select', p)"
        @remove="(p: string) => emit('remove', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.cat-node {
  font-size: 13px;
}

.cat-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.cat-row:hover {
  background: #f1f3f7;
}

.cat-node.active > .cat-row {
  background: #eef2ff;
  color: var(--primary-dark);
  font-weight: 600;
}

.cat-toggle {
  width: 16px;
  text-align: center;
  color: var(--muted);
  flex-shrink: 0;
}

.cat-toggle.leaf {
  cursor: default;
}

.cat-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat-count {
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}

.cat-del {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.cat-row:hover .cat-del {
  opacity: 1;
}

.cat-del:hover {
  color: var(--danger);
}
</style>
