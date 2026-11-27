<script setup lang="ts">
// 通用应用内确认弹窗（2026-11-28）
// 背景：桌面/移动 webview 会屏蔽 window.confirm，导致「点了没反应」。
// 用法：<ConfirmDialog v-model:open / :open="x" title="…" message="…" danger @confirm="doIt" @cancel="x=false" />
withDefaults(
  defineProps<{
    open: boolean
    title?: string
    message?: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    busy?: boolean
  }>(),
  { title: '确认操作', message: '', confirmText: '确认', cancelText: '取消', danger: false, busy: false },
)

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cf-mask" @click.self="emit('cancel')">
      <div class="cf-dialog" role="dialog" :aria-label="title">
        <div class="cf-title">{{ title }}</div>
        <div v-if="message" class="cf-body">{{ message }}</div>
        <slot />
        <div class="cf-actions">
          <button class="cf-btn" type="button" :disabled="busy" @click="emit('cancel')">{{ cancelText }}</button>
          <button class="cf-btn" :class="{ danger }" type="button" :disabled="busy" @click="emit('confirm')">
            {{ busy ? '处理中…' : confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cf-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.cf-dialog {
  width: min(420px, 100%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 18px 14px;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
}
.cf-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.cf-body {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.cf-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.cf-btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.cf-btn.danger {
  border-color: var(--danger, #dc2626);
  background: var(--danger, #dc2626);
  color: #fff;
}
.cf-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
