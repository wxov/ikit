<script setup lang="ts">
import { ref } from 'vue'
import { applyUpdate, filenameFromUrl, saveBlob, type UpdateInfo } from '../lib/update'

const props = defineProps<{ info: UpdateInfo }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'applied'): void
}>()

type Phase = 'confirm' | 'downloading' | 'downloaded' | 'done' | 'error'

const phase = ref<Phase>('confirm')
const pct = ref(0)
const status = ref('')
const error = ref('')
const installerBlob = ref<Blob | null>(null)

async function start() {
  phase.value = 'downloading'
  pct.value = 0
  status.value = props.info.installerUrl ? '正在下载安装包…' : '正在下载更新包…'
  error.value = ''
  try {
    const r = await applyUpdate(props.info, (p) => {
      pct.value = p
    })
    if (r.hardUpdate && r.installerBlob) {
      installerBlob.value = r.installerBlob
      phase.value = 'downloaded'
    } else if (r.applied) {
      phase.value = 'done'
      status.value = '更新完成，即将生效'
      emit('applied')
    } else {
      phase.value = 'error'
      error.value = '当前环境不支持自动更新，请手动下载更新。'
    }
  } catch (e: any) {
    phase.value = 'error'
    error.value = e?.message || '更新失败'
  }
}

function install() {
  if (!installerBlob.value) return
  saveBlob(installerBlob.value, filenameFromUrl(props.info.installerUrl || ''))
  status.value = '安装包已保存，请运行安装程序完成安装。'
  phase.value = 'done'
  emit('applied')
}
</script>

<template>
  <div class="upd-overlay" @click.self="emit('close')">
    <div class="upd-modal">
      <h3>🔄 软件更新</h3>

      <!-- 确认 -->
      <template v-if="phase === 'confirm'">
        <div class="upd-info">
          <p class="upd-ver">发现新版本 <b>v{{ info.latest }}</b>（当前 v{{ info.currentVersion }}）</p>
          <p v-if="info.installerUrl" class="upd-note">本次为<b>硬更新</b>：需下载安装包后重新安装。</p>
          <p v-else class="upd-note">本次为<b>热更新</b>：下载最新资源后自动生效，无需重装。</p>
        </div>
        <div class="upd-actions">
          <button class="upd-btn" @click="start">确认更新</button>
          <button class="upd-btn ghost" @click="emit('close')">取消</button>
        </div>
      </template>

      <!-- 下载进度 -->
      <template v-else-if="phase === 'downloading'">
        <div class="upd-progress">
          <div class="upd-bar"><i :style="{ width: pct + '%' }" /></div>
          <span class="upd-pct">{{ pct }}%</span>
        </div>
        <p class="upd-status">{{ status }}</p>
      </template>

      <!-- 安装包已下载 -->
      <template v-else-if="phase === 'downloaded'">
        <p class="upd-status">✅ 安装包已下载完成。</p>
        <div class="upd-actions">
          <button class="upd-btn" @click="install">立即安装</button>
          <button class="upd-btn ghost" @click="emit('close')">稍后</button>
        </div>
      </template>

      <!-- 完成 -->
      <template v-else-if="phase === 'done'">
        <p class="upd-status">{{ status }}</p>
        <div class="upd-actions">
          <button class="upd-btn" @click="emit('close')">确定</button>
        </div>
      </template>

      <!-- 失败 -->
      <template v-else>
        <p class="upd-status bad">❌ {{ error }}</p>
        <div class="upd-actions">
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
.upd-actions { display: flex; gap: 10px; margin-top: 18px; }
.upd-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.upd-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.upd-progress { display: flex; align-items: center; gap: 10px; margin: 6px 0 10px; }
.upd-bar { flex: 1; height: 10px; background: var(--border); border-radius: 999px; overflow: hidden; }
.upd-bar i { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.2s ease; }
.upd-pct { font-size: 13px; font-weight: 600; min-width: 40px; text-align: right; color: var(--primary-dark); }
.upd-status { margin: 0; font-size: 13px; color: var(--text); }
.upd-status.bad { color: var(--danger); }
</style>
