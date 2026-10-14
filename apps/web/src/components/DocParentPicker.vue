<script setup lang="ts">
import { computed, ref, watch } from 'vue'

// 「可搜索层级下拉」父文档选择器（公共组件）：
// - 由 `packages/plugins/knowledge` 的条目列表回溯出完整路径（如 `技术笔记 / Vue / 组件`）后传入 `docs`；
// - 含「顶层」选项与「清空」按钮（`v-model` 为空串 = 顶层）；
// - 支持关键字过滤（标题 / 路径）、候选上限提示。
//
// 消费方：
//   1) `ImportDocsDialog.vue`（导入到）—— 由本组件抽取而来，交互与样式逐字保持一致；
//   2) `BatchMoveDialog.vue`（批量移动目标）—— 并额外过滤掉「选中项自身及其子孙」等非法目标。
export interface DocOption {
  id: string
  /** 完整层级路径，如 `技术笔记 / Vue / 组件` */
  path: string
}

const props = withDefaults(
  defineProps<{
    /** 选中的父文档 id；空串 = 顶层 */
    modelValue: string
    docs: DocOption[]
    /** 区块标题（如「导入到」/「移动到」）；为空则只渲染下拉本体 */
    label?: string
    /** 未选择时的展示文案 */
    emptyLabel?: string
    /** 选中的 id 不在 `docs` 中（异常兜底）时的展示文案 */
    fallbackLabel?: string
    placeholder?: string
    /** 忙碌时禁用（展开 / 选择 / 清空） */
    disabled?: boolean
    /** 候选展示上限（超出提示用关键字过滤） */
    limit?: number
  }>(),
  {
    label: '',
    emptyLabel: '顶层（无父文档）',
    fallbackLabel: '已选父文档',
    placeholder: '搜索父文档标题 / 路径…',
    disabled: false,
    limit: 100,
  },
)

const emit = defineEmits<{ (e: 'update:modelValue', id: string): void }>()

const query = ref('')
const open = ref(false)

const currentLabel = computed(() => {
  if (!props.modelValue) return props.emptyLabel
  return props.docs.find((d) => d.id === props.modelValue)?.path || props.fallbackLabel
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q ? props.docs.filter((d) => d.path.toLowerCase().includes(q)) : props.docs
  return list.slice(0, props.limit)
})

const truncated = computed(() => !query.value.trim() && props.docs.length > props.limit)

function pick(id: string) {
  if (props.disabled) return // 忙碌时禁止改挂载目标
  emit('update:modelValue', id)
  query.value = ''
  open.value = false
}

function clear() {
  pick('')
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

// 外部改动选中值（如导入弹窗「＋ 新建父文档」创建后自动选中）→ 收起下拉并清空过滤词
watch(
  () => props.modelValue,
  () => {
    open.value = false
    query.value = ''
  },
)
</script>

<template>
  <div class="dpp">
    <div class="dpp-head">
      <span v-if="label" class="dpp-label">{{ label }}</span>
      <span class="dpp-cur" :title="currentLabel">{{ currentLabel }}</span>
      <button v-if="modelValue" class="dpp-mini" :disabled="disabled" @click="clear">清空</button>
      <slot name="actions" />
    </div>
    <div class="dpp-picker">
      <button class="dpp-picker-btn" :disabled="disabled" @click="toggle">
        <span class="dpp-picker-txt">{{ currentLabel }}</span>
        <span class="dpp-caret">▾</span>
      </button>
      <div v-if="open" class="dpp-picker-mask" @click="open = false"></div>
      <div v-if="open" class="dpp-picker-pop">
        <input v-model="query" class="dpp-picker-search" :placeholder="placeholder" autofocus />
        <div class="dpp-picker-list">
          <div class="dpp-picker-opt" :class="{ on: !modelValue }" @click="pick('')">
            {{ emptyLabel }}
          </div>
          <div
            v-for="d in filtered"
            :key="d.id"
            class="dpp-picker-opt"
            :class="{ on: modelValue === d.id }"
            @click="pick(d.id)"
          >
            {{ d.path }}
          </div>
          <div v-if="query.trim() && !filtered.length" class="dpp-picker-empty">无匹配文档</div>
          <div v-else-if="!docs.length" class="dpp-picker-empty">暂无可选文档</div>
          <div v-else-if="truncated" class="dpp-picker-empty">
            仅显示前 {{ limit }} 条，可输入关键字过滤（共 {{ docs.length }} 条）
          </div>
        </div>
      </div>
    </div>
    <!-- 默认插槽：消费方的附加内容（如导入弹窗的「＋ 新建父文档」子表单）保持在同一边框卡片内 -->
    <slot />
  </div>
</template>

<style scoped>
/* 样式自 ImportDocsDialog 的「导入到」区块原样抽取（保证导入弹窗观感不变） */
.dpp {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 14px;
}
.dpp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dpp-label { font-size: 12px; font-weight: 700; color: var(--text); }
.dpp-cur {
  font-size: 12px; color: var(--muted); flex: 1 1 120px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dpp-mini {
  border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.dpp-mini:disabled { opacity: 0.6; cursor: default; }
.dpp-picker { position: relative; margin-top: 8px; }
.dpp-picker-btn {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 7px 10px; font-size: 13px; cursor: pointer; font-family: inherit;
  text-align: left;
}
.dpp-picker-btn:disabled { opacity: 0.6; cursor: default; }
.dpp-picker-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dpp-caret { color: var(--muted); font-size: 11px; }
.dpp-picker-mask { position: fixed; inset: 0; z-index: 1; }
.dpp-picker-pop {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 2;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18); padding: 8px;
}
.dpp-picker-search {
  width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 8px;
  padding: 6px 8px; font-size: 13px; font-family: inherit;
  background: var(--panel); color: var(--text); margin-bottom: 6px;
}
.dpp-picker-list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.dpp-picker-opt {
  padding: 6px 8px; border-radius: 6px; font-size: 13px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dpp-picker-opt:hover { background: var(--primary-soft); }
.dpp-picker-opt.on { background: var(--primary-soft); color: var(--primary-dark); font-weight: 600; }
.dpp-picker-empty { font-size: 12px; color: var(--muted); padding: 6px 8px; }
</style>
