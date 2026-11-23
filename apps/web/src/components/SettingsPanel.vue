<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { api } from '../lib/api'
import { fetchUpdateManifest, hasUpdate as hasUpdateFn, detectPlatform, type UpdateInfo } from '../lib/update'

const emit = defineEmits<{ (e: 'close'): void; (e: 'request-update', info: UpdateInfo): void }>()
const tab = ref<'update' | 'about' | 'download' | 'help'>('update')
const info = ref<UpdateInfo | null>(null)
const checking = ref(false)
const checked = ref(false)
const system = ref<{ name?: string; version?: string } | null>(null)
const platform = detectPlatform()

async function checkUpdate() {
  checking.value = true
  checked.value = true
  try {
    info.value = await fetchUpdateManifest()
  } finally {
    checking.value = false
  }
}

function openUpdate() {
  if (info.value) emit('request-update', info.value)
}

async function loadSystem() {
  try {
    const r = await api<{ name?: string; version?: string }>('/api/system/info')
    system.value = r
  } catch {
    system.value = null
  }
}

onMounted(() => {
  checkUpdate()
  loadSystem()
  loadDownloads()
})

// ---- 下载中心（2026-11-23）：各平台安装包 / 热更新包地址 ----
interface DownloadItem {
  id: 'windows' | 'android' | 'web'
  label: string
  hint: string
  url: string
  configured: boolean
}
const downloads = ref<DownloadItem[]>([])
const downloadVersion = ref('')
const downloadsLoading = ref(false)
const downloadError = ref('')
const copiedId = ref('')

async function loadDownloads() {
  downloadsLoading.value = true
  downloadError.value = ''
  try {
    const r = await api<{ version: string; items: DownloadItem[] }>('/api/update/downloads')
    downloadVersion.value = r.version
    downloads.value = r.items
  } catch (e: any) {
    downloadError.value = e?.message ?? String(e)
  } finally {
    downloadsLoading.value = false
  }
}

/** 当前平台对应的下载项（高亮） */
const currentDownloadId = computed(() =>
  platform === 'tauri' ? 'windows' : platform === 'capacitor' ? 'android' : 'web',
)

function openDownload(item: DownloadItem) {
  if (item.url) window.open(item.url, '_blank', 'noopener')
}

async function copyDownload(item: DownloadItem) {
  if (!item.url) return
  try {
    await navigator.clipboard.writeText(item.url)
    copiedId.value = item.id
    setTimeout(() => {
      if (copiedId.value === item.id) copiedId.value = ''
    }, 2000)
  } catch {
    downloadError.value = '复制失败，请手动选择链接复制'
  }
}

const FAQS: Array<[string, string]> = [
  ['如何使用知识库？', '在首页卡片流或左栏目录中点击文章阅读；站主可点「新建文章」或目录「＋/⋯」管理，支持 Markdown 与封面图。'],
  ['如何评论 / 评分？', '打开文章后在评论区发表评论（需登录）；评分/点赞/浏览在卡片与详情页展示。'],
  ['怎么搜索？', '顶栏全局搜索（Ctrl+K），支持按标题/标签匹配；右侧「分类」「标签云」可快速筛选。'],
  ['如何回收/恢复文章？', '删除的文章进入左栏「回收站」，站主可恢复或彻底删除；「归档」按时间浏览全部文章。'],
  ['账号如何创建？', '注册已关闭，由站主在「用户管理」中手动添加；登录后可在头像菜单「编辑资料」改用户名/密码。'],
  ['如何安装新插件？', '站主进入「商店」安装/更新/卸载；安装后页面自动刷新，可在「插件」管理中启停与调整可见性。'],
]
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-panel">
      <header class="st-head">
        <h3>设置</h3>
        <button class="st-x" @click="emit('close')">×</button>
      </header>
      <nav class="st-tabs">
        <button :class="{ on: tab === 'update' }" @click="tab = 'update'">检查更新</button>
        <button :class="{ on: tab === 'about' }" @click="tab = 'about'">关于</button>
        <button :class="{ on: tab === 'download' }" @click="tab = 'download'; loadDownloads()">下载</button>
        <button :class="{ on: tab === 'help' }" @click="tab = 'help'">帮助</button>
      </nav>

      <section v-if="tab === 'update'" class="st-body">
        <div class="up-row">
          <span class="up-version">当前版本 <b>v{{ info?.currentVersion ?? '…' }}</b></span>
          <span class="up-version latest">最新版本 <b>v{{ info?.latest ?? '…' }}</b></span>
          <button class="st-btn" :disabled="checking" @click="checkUpdate">{{ checking ? '检查中…' : '检查更新' }}</button>
        </div>
        <div v-if="checked && info" class="up-result" :class="{ ok: !hasUpdateFn(info), bad: hasUpdateFn(info) }">
          <template v-if="hasUpdateFn(info)">
            发现新版本 v{{ info.latest }}，<a class="up-link" @click="openUpdate">更新</a>
          </template>
          <template v-else>已是最新版本（v{{ info.latest }}）</template>
        </div>
        <p class="up-note">构建时间：{{ info?.buildTime ?? '—' }} · 平台：{{ platform }}</p>
      </section>

      <section v-else-if="tab === 'about'" class="st-body">
        <div class="about-box">
          <div class="about-logo">🧠 i-kit</div>
          <div class="about-name">知识门户</div>
          <div class="about-meta">版本 v{{ info?.currentVersion ?? system?.version ?? '0.2.0' }}</div>
          <p class="about-desc">
            机器人 + Web 服务 + AI Agent 成套项目，基于自研 Cordis 插件架构；知识库 / 小知（DocCurator）/ 插件商店 /
            多角色权限，Web / 桌面（Tauri）/ 移动（Capacitor）三端同源。
          </p>
          <p class="about-agent">
            <b>小知（DocCurator）</b>是 i-kit 内置的知识库文档管家：基于你的知识库做检索问答、把零散资料整理归类，
            并按需新增、修改文档。所有写入都会先征求你的确认，且仅站主可用；支持配置多个模型，并按会话选择。
          </p>
          <div class="about-meta">GitHub：<a class="up-link" href="https://github.com/wxov/ikit" target="_blank" rel="noopener">github.com/wxov/ikit</a></div>
        </div>
      </section>

      <!-- 下载中心：各平台安装包 / 热更新包（地址来自服务端 /api/update/downloads） -->
      <section v-else-if="tab === 'download'" class="st-body">
        <p class="dl-hint">
          当前服务端版本 <b>v{{ downloadVersion || info?.currentVersion || '…' }}</b>。安装包用于覆盖安装/更新；
          地址由服务端下发（域名：download 子域）。
        </p>
        <div v-if="downloadsLoading" class="dl-hint">加载中…</div>
        <div v-else class="dl-list">
          <div v-for="d in downloads" :key="d.id" class="dl-item" :class="{ cur: currentDownloadId === d.id }">
            <div class="dl-main">
              <div class="dl-label">
                {{ d.label }}
                <span v-if="currentDownloadId === d.id" class="dl-cur">当前平台</span>
              </div>
              <div class="dl-hint">{{ d.hint }}</div>
              <div class="dl-url" :title="d.url">{{ d.url }}</div>
            </div>
            <div class="dl-actions">
              <button class="st-btn" :disabled="!d.url" @click="openDownload(d)">打开下载</button>
              <button class="st-btn" :disabled="!d.url" @click="copyDownload(d)">
                {{ copiedId === d.id ? '已复制' : '复制链接' }}
              </button>
            </div>
          </div>
          <div v-if="downloadError" class="dl-error">❌ {{ downloadError }}</div>
        </div>
      </section>

      <section v-else-if="tab === 'help'" class="st-body">
        <div class="faq-list">
          <details v-for="[q, a] in FAQS" :key="q" class="faq-item">
            <summary class="faq-q">{{ q }}</summary>
            <p class="faq-a">{{ a }}</p>
          </details>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed; inset: 0; z-index: 650;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.settings-panel {
  width: 520px; max-width: 100%; max-height: 80vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 20px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}
.st-head { display: flex; align-items: center; justify-content: space-between; }
.st-head h3 { margin: 0; }
.st-x { border: none; background: transparent; color: var(--muted); font-size: 24px; cursor: pointer; line-height: 1; }
.st-tabs { display: flex; gap: 4px; margin: 14px 0; border-bottom: 1px solid var(--border); }
.st-tabs button {
  border: none; background: transparent; color: var(--muted); padding: 8px 14px;
  border-radius: 8px 8px 0 0; font-size: 13px; cursor: pointer; font-family: inherit;
  border-bottom: 2px solid transparent;
}
.st-tabs button.on { color: var(--primary-dark); font-weight: 600; border-bottom-color: var(--primary); }
.st-body { padding-top: 4px; }
.up-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.up-version { font-size: 13px; color: var(--muted); }
.up-version b { color: var(--text); }
.up-version.latest b { color: var(--primary-dark); }
.up-result { margin-top: 12px; font-size: 13px; }
.up-result.ok { color: var(--ok); }
.up-result.bad { color: var(--warn); }
.up-note { margin-top: 10px; font-size: 11px; color: var(--muted); }
.up-link { color: var(--primary-dark); cursor: pointer; text-decoration: underline; }
.st-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.st-btn:disabled { opacity: 0.6; }
.about-box { text-align: center; padding: 8px 0; }
.about-logo { font-size: 34px; }
.about-name { font-size: 18px; font-weight: 700; margin-top: 4px; }
.about-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
.about-desc { font-size: 13px; color: var(--text); line-height: 1.8; margin: 12px auto 0; max-width: 420px; text-align: left; }
.faq-list { display: flex; flex-direction: column; gap: 10px; }
.faq-item { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; background: var(--bg); }
.faq-q { font-size: 13px; font-weight: 600; cursor: pointer; }
.faq-a { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 6px 0 0; }

.about-agent {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.75;
}

/* 下载中心 */
.dl-hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0 0 10px; }
.dl-list { display: flex; flex-direction: column; gap: 10px; }
.dl-item {
  display: flex; align-items: center; gap: 12px;
  border: 1px solid var(--border); border-radius: 12px; padding: 12px;
}
.dl-item.cur { border-color: var(--primary); background: var(--primary-soft); }
.dl-main { flex: 1 1 auto; min-width: 0; }
.dl-label { font-size: 14px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; }
.dl-cur {
  font-size: 11px; font-weight: 400; color: var(--primary-dark);
  border: 1px solid var(--primary); border-radius: 999px; padding: 0 8px;
}
.dl-url {
  font-size: 12px; color: var(--muted); margin-top: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dl-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.dl-error { font-size: 12px; color: var(--danger, #dc2626); }
@media (max-width: 768px) {
  .dl-item { flex-direction: column; align-items: stretch; }
  .dl-actions { justify-content: flex-end; }
}
</style>
