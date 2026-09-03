<script setup lang="ts">
import { ref, computed } from 'vue'
import { applyUpdate, openInstallerUrl, type UpdateInfo } from '../lib/update'

const props = defineProps<{ info: UpdateInfo }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'applied'): void
}>()

type Phase = 'confirm' | 'downloading' | 'done' | 'error'

const phase = ref<Phase>('confirm')
const pct = ref(0)
const status = ref('')
const error = ref('')

// 是否有热更新通道（web 分发包）与硬更新通道（完整安装包）
const hasHot = computed(() => !!props.info.bundleUrl)
const hasHard = computed(() => !!props.info.installerUrl)

async function startHot() {
  phase.value = 'downloading'
  pct.value = 0
  status.value = '正在下载更新包…'
  error.value = ''
  try {
    const r = await applyUpdate(props.info, (p) => {
      pct.value = p
    })
    if (r.applied) {
      phase.value = 'done'
      status.value = '更新完成，正在重新加载…'
      emit('applied')
    } else {
      phase.value = 'error'
      error.value = '热更新通道不可用，请改用「下载完整安装包」更新。'
    }
  } catch (e: any) {
    phase.value = 'error'
    error.value = e?.message || '更新失败'
  }
}

function startInstaller() {
  if (props.info.installerUrl) {
    openInstallerUrl(props.info.installerUrl)
    phase.value = 'done'
    status.value = '已打开下载页，请下载并运行安装包完成更新。'
    emit('applied')
  }
}
</script>

<template>
  <div class="upd-overlay" @click.self="emit('close')">
    <div class="upd-modal">
      <h3>🔄 软件更新</h3>

      <!-- 确认 / 选择更新方式 -->
      <template v-if="phase === 'confirm'">
        <div class="upd-info">
          <p class="upd-ver">发现新版本 <b>v{{ info.latest }}</b>（当前 v{{ info.currentVersion }}）</p>
        </div>
        <template v-if="hasHot && hasHard">
          <p class="upd-note">请选择更新方式：</p>
          <div class="upd-actions col">
            <button class="upd-btn" @click="startHot">🚀 热更新（免重装，推荐）</button>
            <button class="upd-btn outline" @click="startInstaller">📦 下载完整安装包</button>
            <button class="upd-btn ghost" @click="emit('close')">取消</button>
          </div>
        </template>
        <template v-else-if="hasHot">
          <p class="upd-note">本次为<b>热更新</b>：下载最新资源后自动生效，无需重装。</p>
          <div class="upd-actions col">
            <button class="upd-btn" @click="startHot">确认热更新</button>
            <button class="upd-btn ghost" @click="emit('close')">取消</button>
          </div>
        </template>
        <template v-else-if="hasHard">
          <p class="upd-note">本次为<b>硬更新</b>：需下载安装包后重新安装。</p>
          <div class="upd-actions col">
            <button class="upd-btn" @click="startInstaller">下载安装包</button>
            <button class="upd-btn ghost" @click="emit('close')">取消</button>
          </div>
        </template>
        <template v-else>
          <p class="upd-status bad">该版本无可用更新通道。</p>
          <div class="upd-actions col">
            <button class="upd-btn ghost" @click="emit('close')">关闭</button>
          </div>
        </template>
      </template>

      <!-- 下载进度（热更新） -->
      <template v-else-if="phase === 'downloading'">
        <div class="upd-progress">
          <div class="upd-bar"><i :style="{ width: pct + '%' }" /></div>
          <span class="upd-pct">{{ pct }}%</span>
        </div>
        <p class="upd-status">{{ status }}</p>
      </template>

      <!-- 完成 / 已打开下载页 -->
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
.upd-btn.outline { background: transparent; color: var(--primary-dark); }
.upd-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.upd-progress { display: flex; align-items: center; gap: 10px; margin: 6px 0 10px; }
.upd-bar { flex: 1; height: 10px; background: var(--border); border-radius: 999px; overflow: hidden; }
.upd-bar i { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.2s ease; }
.upd-pct { font-size: 13px; font-weight: 600; min-width: 40px; text-align: right; color: var(--primary-dark); }
.upd-status { margin: 0; font-size: 13px; color: var(--text); }
.upd-status.bad { color: var(--danger); }
</style>
