<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  applyUpdate,
  applyInstallerUpdate,
  detectPlatform,
  type UpdateInfo,
} from '../lib/update'

const props = defineProps<{ info: UpdateInfo }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'applied'): void
}>()

type Phase = 'confirm' | 'working' | 'done' | 'error'

const phase = ref<Phase>('confirm')
const status = ref('')
const error = ref('')

// 按发布判定类型（服务端 updateKind）决定本弹窗只走哪一条通道，不让用户选择
const isHard = computed(
  () => props.info.updateKind === 'hard' && detectPlatform() !== 'web',
)

async function startHot() {
  phase.value = 'working'
  status.value = '正在下载更新包…'
  error.value = ''
  try {
    const r = await applyUpdate(props.info, (pct) => {
      status.value = `正在下载更新包… ${pct}%`
    })
    if (r.applied) {
      phase.value = 'done'
      status.value = '更新完成，正在重新加载…'
      emit('applied')
    } else {
      phase.value = 'error'
      error.value = '热更新不可用，请稍后重试或到下载页获取完整安装包。'
    }
  } catch (e: any) {
    phase.value = 'error'
    error.value = e?.message || '更新失败'
  }
}

async function startInstaller() {
  phase.value = 'working'
  status.value = '正在下载安装包并准备安装…'
  error.value = ''
  try {
    const r = await applyInstallerUpdate(props.info)
    if (r.launched) {
      phase.value = 'done'
      status.value = '已启动安装程序，请在弹出的安装向导中完成更新。'
      emit('applied')
    } else {
      phase.value = 'done'
      status.value = '已打开下载页，请下载并运行安装包完成更新。'
      emit('applied')
    }
  } catch (e: any) {
    phase.value = 'error'
    error.value = e?.message || '安装包下载失败'
  }
}
</script>

<template>
  <div class="upd-overlay" @click.self="emit('close')">
    <div class="upd-modal">
      <h3>🔄 软件更新</h3>

      <!-- 确认（单通道，按服务端判定类型展示） -->
      <template v-if="phase === 'confirm'">
        <p class="upd-ver">
          发现新版本 <b>v{{ info.latest }}</b>（当前 v{{ info.currentVersion }}）
        </p>
        <template v-if="isHard">
          <p class="upd-note">本次为<b>完整安装包更新</b>：将自动下载安装包并弹出安装提示。</p>
          <div class="upd-actions col">
            <button class="upd-btn" @click="startInstaller">确认更新</button>
            <button class="upd-btn ghost" @click="emit('close')">取消</button>
          </div>
        </template>
        <template v-else>
          <p class="upd-note">本次为<b>热更新</b>：下载最新资源后自动生效，无需重装。</p>
          <div class="upd-actions col">
            <button class="upd-btn" @click="startHot">确认更新</button>
            <button class="upd-btn ghost" @click="emit('close')">取消</button>
          </div>
        </template>
      </template>

      <!-- 处理中 -->
      <template v-else-if="phase === 'working'">
        <p class="upd-status">{{ status }}</p>
        <div class="upd-actions col">
          <button class="upd-btn ghost" :disabled="true">处理中…</button>
        </div>
      </template>

      <!-- 完成 -->
      <template v-else-if="phase === 'done'">
        <p class="upd-status">{{ status }}</p>
        <div class="upd-actions col">
          <button class="upd-btn" @click="emit('close')">确定</button>
        </div>
      </template>

      <!-- 失败 -->
      <template v-else>
        <p class="upd-status bad">❌ {{ error }}</p>
        <div class="upd-actions col">
          <button class="upd-btn ghost" @click="emit('close')">关闭</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.upd-overlay {
  position: fixed; inset: 0; z-index: 560;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.upd-modal {
  width: min(420px, 94vw);
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px;
}
.upd-modal h3 { margin: 0 0 14px; }
.upd-ver { margin: 0; font-size: 14px; }
.upd-ver b { color: var(--primary-dark); }
.upd-note { margin: 10px 0 0; font-size: 13px; color: var(--muted); }
.upd-note b { color: var(--text); }
.upd-actions { display: flex; gap: 10px; margin-top: 18px; }
.upd-actions.col { flex-direction: column; }
.upd-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 9px 18px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.upd-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.upd-btn:disabled { opacity: 0.6; cursor: default; }
.upd-status { margin: 0; font-size: 13px; color: var(--text); }
.upd-status.bad { color: var(--danger); }
</style>
