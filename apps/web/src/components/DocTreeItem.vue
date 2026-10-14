<script setup lang="ts">
import type { KnowledgeEntry } from '../lib/api'

export interface DocNode {
  entry: KnowledgeEntry
  children: DocNode[]
}

const props = defineProps<{
  node: DocNode
  depth: number
  selectedId: string
  batchMode: boolean
  /** 批量模式：已勾选的条目 id（被选中的根，勾选父级时其子孙不入集合） */
  batchSelected?: Set<string>
  /** 批量模式：随父级处理的条目 id（祖先已勾选 → 禁用单独勾选、并标记提示） */
  batchCascade?: Set<string>
  searchQ: string
  expandedDocs: Record<string, boolean>
  menuFor: string
  highlight: (text: string, q: string) => string
  // 拖拽排序
  dragId?: string
  overId?: string
  overPos?: 'top' | 'middle' | 'bottom'
  // 移动选择器
  movePickerFor?: string
  moveTargetParent?: string | ''
  forbidden?: boolean
  // 移动选择模式：点击行即作为目标
  movePickMode?: boolean
  // 是否隐藏展开箭头（选择模式）
  hideToggle?: boolean
  // 站主模式：显示拖动排序与 ＋/⋯ 操作
  admin?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'toggle', id: string): void
  (e: 'toggleSelect', id: string): void
  (e: 'menu', id: string): void
  (e: 'addChild', id: string): void
  (e: 'dragStart', id: string): void
  (e: 'dragOver', id: string, pos: 'top' | 'middle' | 'bottom'): void
  (e: 'drop', id: string, pos: 'top' | 'middle' | 'bottom'): void
  (e: 'dragEnd'): void
  (e: 'pickMoveTarget', id: string): void
}>()

function dropPos(e: MouseEvent): 'top' | 'middle' | 'bottom' {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const ratio = (e.clientY - rect.top) / rect.height
  if (ratio < 0.25) return 'top'
  if (ratio > 0.75) return 'bottom'
  return 'middle'
}

function onRowClick() {
  if (props.batchMode) emit('toggleSelect', props.node.entry.id)
  else if (props.movePickMode) emit('pickMoveTarget', props.node.entry.id)
  else emit('select', props.node.entry.id)
}

// 批量模式：勾选态 / 随父级处理态（祖先已选 → 由祖先级联覆盖，不单独勾选）
function isChecked(id: string): boolean {
  return !!props.batchSelected?.has(id)
}
function isCascade(id: string): boolean {
  return !!props.batchCascade?.has(id)
}
</script>

<template>
  <div class="doc-tree-node">
    <div
      class="doc-item"
      :data-doc-id="node.entry.id"
      :class="{
        active: !batchMode && node.entry.id === selectedId,
        'drag-over-top': !batchMode && overId === node.entry.id && overPos === 'top' && dragId !== node.entry.id,
        'drag-over-bottom': !batchMode && overId === node.entry.id && overPos === 'bottom' && dragId !== node.entry.id,
        'drag-over-child':
          !batchMode && overId === node.entry.id && overPos === 'middle' && dragId !== node.entry.id && !forbidden,
        'move-target':
          !batchMode && movePickerFor && moveTargetParent === node.entry.id && !forbidden,
      }"
      :draggable="!!admin && !batchMode && !movePickMode"
      :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
      @click="onRowClick"
      @dragstart="emit('dragStart', node.entry.id)"
      @dragover.prevent="emit('dragOver', node.entry.id, dropPos($event))"
      @drop.prevent="emit('drop', node.entry.id, dropPos($event))"
      @dragend="emit('dragEnd')"
    >
      <div class="doc-item-row">
        <!-- 批量模式复选框：随父级处理的条目禁用并显示提示（不破坏拖拽 / 菜单 / 单条选中逻辑） -->
        <div
          v-if="batchMode && !isCascade(node.entry.id)"
          class="kb-check"
          :class="{ on: isChecked(node.entry.id) }"
          :title="isChecked(node.entry.id) ? '取消选择' : '选择'"
          @click.stop="emit('toggleSelect', node.entry.id)"
        >
          {{ isChecked(node.entry.id) ? '✓' : '' }}
        </div>
        <div
          v-else-if="batchMode"
          class="kb-check disabled"
          title="随父级处理（父级已选中，无需单独勾选）"
          @click.stop
        >
          ·
        </div>
        <!-- 展开箭头：批量模式下仍可折叠 / 展开（不改变非批量模式的渲染） -->
        <span
          v-if="!hideToggle && node.children.length"
          class="doc-tree-arrow"
          :class="{ open: expandedDocs[node.entry.id] }"
          @click.stop="emit('toggle', node.entry.id)"
          >▸</span
        >
        <span v-else-if="!hideToggle" class="doc-tree-arrow leaf">•</span>
        <div class="doc-item-main">
          <div class="doc-item-title">
            <span v-if="node.entry.pinned" class="pin-icon">📌</span>
            <span v-html="props.highlight(node.entry.title, searchQ)"></span>
            <span v-if="batchMode && isCascade(node.entry.id)" class="kb-cascade">随父级处理</span>
          </div>
        </div>
        <!-- hover 操作（仅站主） -->
        <div v-if="admin && !batchMode && !movePickMode" class="doc-item-actions" @click.stop>
          <button class="ia-btn" title="新建子文档" @click="emit('addChild', node.entry.id)">＋</button>
          <button class="ia-btn" title="更多操作" @click="emit('menu', menuFor === node.entry.id ? '' : node.entry.id)">⋯</button>
        </div>
      </div>

      <!-- ⋯ 操作菜单 -->
      <div v-if="menuFor === node.entry.id" class="doc-menu" @click.stop>
        <div class="doc-menu-item" @click="emit('addChild', node.entry.id)">＋ 新建子文档</div>
        <div class="doc-menu-item" @click="emit('pickMoveTarget', node.entry.id)">⇅ 移动到…</div>
        <!-- entry-menu 插槽：当前展开菜单的条目 id 由外层 menuFor 持有（避免递归组件自引用推断） -->
        <slot name="entry-menu" />
      </div>
    </div>

    <!-- 子文档递归 -->
    <template v-if="node.children.length && expandedDocs[node.entry.id]">
      <DocTreeItem
        v-for="c in node.children"
        :key="c.entry.id"
        :node="c"
        :depth="depth + 1"
        :selected-id="selectedId"
        :batch-mode="batchMode"
        :batch-selected="batchSelected"
        :batch-cascade="batchCascade"
        :search-q="searchQ"
        :expanded-docs="expandedDocs"
        :menu-for="menuFor"
        :highlight="highlight"
        :drag-id="dragId"
        :over-id="overId"
        :over-pos="overPos"
        :move-picker-for="movePickerFor"
        :move-target-parent="moveTargetParent"
        :forbidden="forbidden"
        :move-pick-mode="movePickMode"
        :hide-toggle="hideToggle"
        :admin="admin"
        @select="(id) => emit('select', id)"
        @toggle="(id) => emit('toggle', id)"
        @toggle-select="(id) => emit('toggleSelect', id)"
        @menu="(id) => emit('menu', id)"
        @add-child="(id) => emit('addChild', id)"
        @drag-start="(id) => emit('dragStart', id)"
        @drag-over="(id, pos) => emit('dragOver', id, pos)"
        @drop="(id, pos) => emit('drop', id, pos)"
        @drag-end="() => emit('dragEnd')"
        @pick-move-target="(id) => emit('pickMoveTarget', id)"
      />
    </template>
  </div>
</template>

<style scoped>
.doc-tree-arrow {
  width: 16px;
  text-align: center;
  color: var(--muted);
  flex-shrink: 0;
  transition: transform 0.15s;
  cursor: pointer;
}
.doc-tree-arrow.open {
  transform: rotate(90deg);
}
.doc-tree-arrow.leaf {
  font-size: 10px;
  cursor: default;
}

/* 拖拽悬停 - 同级插入到上方：顶部蓝线 */
.doc-item.drag-over-top {
  box-shadow: 0 -2px 0 0 var(--primary);
  background: var(--primary-soft);
}

/* 拖拽悬停 - 同级插入到下方：底部蓝线 */
.doc-item.drag-over-bottom {
  box-shadow: 0 2px 0 0 var(--primary);
  background: var(--primary-soft);
}

/* 拖拽悬停 - 设为子文档：浅蓝底 + 虚线框 */
.doc-item.drag-over-child {
  background: var(--primary-soft);
  color: var(--primary-dark);
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
}

/* 移动目标选择：高亮环 */
.doc-item.move-target {
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
  background: var(--primary-soft);
}
</style>
