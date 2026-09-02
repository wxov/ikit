<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../lib/api'
import { fetchUpdateManifest, hasUpdate as hasUpdateFn, detectPlatform, type UpdateInfo } from '../lib/update'

const emit = defineEmits<{ (e: 'close'): void; (e: 'request-update', info: UpdateInfo): void }>()
const tab = ref<'update' | 'about' | 'help'>('update')
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
})

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
            机器人 + Web 服务 + AI Agent 成套项目，基于自研 Cordis 插件架构；知识库 / AI Agent / 插件商店 /
            多角色权限，Web / 桌面（Tauri）/ 移动（Capacitor）三端同源。
          </p>
          <div class="about-meta">GitHub：<a class="up-link" href="https://github.com/wxov/ikit" target="_blank" rel="noopener">github.com/wxov/ikit</a></div>
        </div>
      </section>

      <section v-else class="st-body">
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
</style>
