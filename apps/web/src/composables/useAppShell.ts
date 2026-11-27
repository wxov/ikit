// App 外壳通用状态（P2-10 前端拆分，2026-11-28）
//
// 从 App.vue 抽出三块彼此独立、与业务无关的 UI 状态：
// - 全局轻提示（appToast，3s 自动消失）
// - 热更新检查（定时轮询 10min + 窗口聚焦/可见时检查）
// - 暗色模式（默认跟随系统，可手动切换，持久化到 localStorage）
import { ref } from 'vue'
import { fetchUpdateManifest, hasUpdate as hasUpdateFn, type UpdateInfo } from '../lib/update'

export interface UseAppShellOptions {
  /** 打开更新弹窗时收起设置面板 */
  settingsOpen: { value: boolean }
}

export function useAppShell({ settingsOpen }: UseAppShellOptions) {
  // ---- 全局轻提示 ----
  const appToast = ref('')
  let appToastTimer: ReturnType<typeof setTimeout> | null = null
  function showAppToast(msg: string) {
    appToast.value = msg
    if (appToastTimer) clearTimeout(appToastTimer)
    appToastTimer = setTimeout(() => (appToast.value = ''), 3000)
  }

  // ---- 热更新 ----
  const updateInfo = ref<UpdateInfo | null>(null)
  const updateAvailable = ref(false)
  const updateOpen = ref(false)

  async function checkUpdate() {
    const info = await fetchUpdateManifest()
    updateInfo.value = info
    if (hasUpdateFn(info)) {
      updateAvailable.value = true
    }
  }

  // 主动推送：定期轮询 + 窗口聚焦/可见时检查（应用打开期间无需重启即可发现更新）
  let updateTimer: number | undefined
  let scheduled = false
  function onVisibilityChanged() {
    if (document.visibilityState === 'visible') checkUpdate()
  }
  function scheduleUpdateChecks() {
    scheduled = true
    updateTimer = window.setInterval(() => checkUpdate(), 10 * 60 * 1000)
    document.addEventListener('visibilitychange', onVisibilityChanged)
    window.addEventListener('focus', checkUpdate)
  }

  function onUpdateApplied() {
    updateAvailable.value = false
  }

  function onRequestUpdate(info: UpdateInfo) {
    updateInfo.value = info
    updateOpen.value = true
    settingsOpen.value = false
  }

  function dismissUpdate() {
    updateAvailable.value = false
  }

  // ---- 暗色模式（默认跟随系统，可手动切换）----
  const theme = ref<'light' | 'dark'>(
    (localStorage.getItem('ikit-theme') as 'light' | 'dark') ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  )

  function applyTheme() {
    document.documentElement.dataset.theme = theme.value
    localStorage.setItem('ikit-theme', theme.value)
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    applyTheme()
  }

  applyTheme()

  /** 卸载清理：定时器与全局监听 */
  function dispose() {
    if (updateTimer !== undefined) clearInterval(updateTimer)
    if (appToastTimer) clearTimeout(appToastTimer)
    if (scheduled) {
      document.removeEventListener('visibilitychange', onVisibilityChanged)
      window.removeEventListener('focus', checkUpdate)
    }
  }

  return {
    appToast,
    showAppToast,
    updateInfo,
    updateAvailable,
    updateOpen,
    checkUpdate,
    scheduleUpdateChecks,
    onUpdateApplied,
    onRequestUpdate,
    dismissUpdate,
    theme,
    toggleTheme,
    dispose,
  }
}
