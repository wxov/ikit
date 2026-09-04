<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  fetchPluginStore,
  fetchPluginCategories,
  installPlugin,
  updatePlugin,
  uninstallPlugin,
  importPlugin,
  downloadPlugin,
  ratePlugin,
  type PluginStoreItem,
} from '../lib/plugins'

const store = ref<PluginStoreItem[]>([])
const categories = ref<string[]>([])
const searchQ = ref('')
const activeCat = ref('all')
const busy = ref('')
const notice = ref('')
const error = ref('')
const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const ratingFor = ref<PluginStoreItem | null>(null)
const rateScore = ref(5)
const rateComment = ref('')
const detailFor = ref<PluginStoreItem | null>(null)

function sourceLabel(p: PluginStoreItem): string {
  if (p.source === 'remote') return '远端'
  if (p.source === 'local') return '本地'
  return ''
}
function canUpdate(p: PluginStoreItem): boolean {
  if (p.updateAvailable !== undefined) return p.updateAvailable
  return !!p.installedVersion && p.installedVersion !== p.version
}
function isThirdParty(p: PluginStoreItem): boolean {
  return p.source === 'local' || p.source === 'remote'
}

function openDetail(p: PluginStoreItem) {
  detailFor.value = p
}
function closeDetail() {
  detailFor.value = null
}

async function load() {
  const [r, c] = await Promise.all([fetchPluginStore(), fetchPluginCategories()])
  store.value = r.store
  categories.value = c.categories
}

async function install(p: PluginStoreItem) {
  busy.value = p.name
  error.value = ''
  try {
    const r = await installPlugin(p.name)
    store.value = r.store
    notice.value = `已安装「${p.title}」，正在刷新…`
    location.reload()
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = ''
  }
}

async function doUpdate(p: PluginStoreItem) {
  busy.value = p.name
  error.value = ''
  try {
    const r = await updatePlugin(p.name)
    store.value = r.store
    notice.value = `已更新「${p.title}」，正在刷新…`
    location.reload()
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = ''
  }
}

async function doUninstall(p: PluginStoreItem) {
  if (!confirm(`确认卸载「${p.title}」？`)) return
  busy.value = p.name
  error.value = ''
  try {
    const r = await uninstallPlugin(p.name)
    store.value = r.store
    notice.value = `已卸载「${p.title}」，正在刷新…`
    location.reload()
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = ''
  }
}

async function doExport(p: PluginStoreItem) {
  busy.value = p.name
  error.value = ''
  try {
    await downloadPlugin(p.name)
    notice.value = `已导出「${p.title}」`
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = ''
  }
}

function triggerImport() {
  fileInput.value?.click()
}

async function onImportFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  // D5：仅 admin + 二次确认 + 风险提示
  if (!confirm(`即将导入插件包「${file.name}」。\n\n风险提示：第三方插件将获得与主程序同等的系统权限，仅安装你信任的来源。\n\n继续导入？`)) return
  if (file.size > 3 * 1024 * 1024) {
    error.value = '插件包超过 2MB 限制'
    return
  }
  importing.value = true
  error.value = ''
  notice.value = ''
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve((r.result as string).split(',')[1] ?? (r.result as string))
      r.onerror = () => reject(new Error('读取文件失败'))
      r.readAsDataURL(file)
    })
    const r = await importPlugin(base64)
    store.value = r.store
    notice.value = `已导入「${file.name}」，正在刷新…`
    location.reload()
  } catch (e: any) {
    error.value = e.message
  } finally {
    importing.value = false
  }
}

function openRate(p: PluginStoreItem) {
  ratingFor.value = p
  rateScore.value = Math.round(p.rating ?? 5)
  rateComment.value = ''
}
async function submitRate() {
  if (!ratingFor.value) return
  const r = await ratePlugin(ratingFor.value.name, rateScore.value, rateComment.value)
  store.value = r.store
  notice.value = '感谢你的评分与评论'
  ratingFor.value = null
}

function stars(n: number | undefined): string {
  const s = Math.round(n ?? 0)
  return '★'.repeat(s) + '☆'.repeat(5 - s)
}

const filtered = computed(() => {
  const q = searchQ.value.trim().toLowerCase()
  return store.value.filter((p) => {
    const catOk = activeCat.value === 'all' || p.category === activeCat.value
    const qOk = !q || p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    return catOk && qOk
  })
})

onMounted(load)
</script>

<template>
  <div class="plugin-store">
    <div class="ps-head">
      <h3>插件商店</h3>
      <span class="ps-sub">浏览、安装、更新、卸载插件（仅站主可操作）</span>
    </div>
    <div class="ps-tools">
      <input v-model="searchQ" class="ps-search" placeholder="搜索插件…" />
      <button class="ps-btn import" :disabled="importing" @click="triggerImport">
        {{ importing ? '导入中…' : '导入插件' }}
      </button>
      <input ref="fileInput" type="file" accept=".zip,application/zip" style="display: none" @change="onImportFile" />
    </div>
    <div class="ps-cats">
      <span
        class="ps-cat-chip"
        :class="{ on: activeCat === 'all' }"
        @click="activeCat = 'all'"
      >全部</span>
      <span
        v-for="c in categories"
        :key="c"
        class="ps-cat-chip"
        :class="{ on: activeCat === c }"
        @click="activeCat = c"
      >{{ c }}</span>
    </div>
    <div v-if="notice" class="ps-notice">{{ notice }}</div>
    <div v-if="error" class="ps-error">{{ error }}</div>

    <div class="ps-grid">
      <div v-for="p in filtered" :key="p.name" class="ps-card">
        <div class="ps-card-top">
          <span class="ps-ico">{{ p.category === '效率' ? '⏱️' : p.category === '工具' ? '🧰' : '🧩' }}</span>
          <span class="ps-cat">{{ p.category }}</span>
        </div>
        <div class="ps-title">{{ p.title }}</div>
        <div class="ps-desc">{{ p.description }}</div>
        <div class="ps-rating">
          <span class="ps-stars">{{ stars(p.rating) }}</span>
          <span class="ps-rating-count">{{ p.ratingCount ?? 0 }} 评分</span>
        </div>
        <div v-if="p.reviews?.length" class="ps-reviews">
          <div v-for="r in p.reviews.slice(-2).reverse()" :key="r.id" class="ps-review">
            <span class="ps-review-author">{{ r.author }}</span>
            <span class="ps-review-stars">{{ stars(r.score) }}</span>
            <span class="ps-review-text">{{ r.comment }}</span>
          </div>
          <span class="ps-more" @click="openRate(p)">查看/写评价…</span>
        </div>
        <div class="ps-meta">
          <span class="ps-author">{{ p.author }}</span>
          <span v-if="sourceLabel(p)" class="ps-source" :class="p.source">{{ sourceLabel(p) }}</span>
          <span class="ps-ver">v{{ p.installed ? p.installedVersion : p.version }}</span>
        </div>
        <div class="ps-actions">
          <button v-if="!p.installed" class="ps-btn" :disabled="busy === p.name" @click="install(p)">安装</button>
          <template v-else>
            <button v-if="canUpdate(p)" class="ps-btn" :disabled="busy === p.name" @click="doUpdate(p)">更新</button>
            <button v-else class="ps-btn ok" disabled>已安装</button>
            <button v-if="isThirdParty(p)" class="ps-btn ghost" :disabled="busy === p.name" @click="doExport(p)">导出</button>
            <button class="ps-btn danger" :disabled="busy === p.name" @click="doUninstall(p)">卸载</button>
          </template>
          <button class="ps-btn ghost" @click="openDetail(p)">详情</button>
          <button class="ps-btn ghost" @click="openRate(p)">评价</button>
        </div>
      </div>
      <div v-if="!filtered.length" class="ps-empty">没有匹配的插件</div>
    </div>

    <!-- 评分/评论弹窗 -->
    <div v-if="ratingFor" class="rate-overlay" @click.self="ratingFor = null">
      <div class="rate-modal">
        <div class="rate-head">
          <span>评价「{{ ratingFor.title }}」</span>
          <button class="rate-close" @click="ratingFor = null">×</button>
        </div>
        <div class="rate-stars">
          <button
            v-for="n in 5"
            :key="n"
            class="rate-star"
            :class="{ on: n <= rateScore }"
            @click="rateScore = n"
          >★</button>
        </div>
        <textarea v-model="rateComment" class="rate-comment" placeholder="写点评价（可选）"></textarea>
        <div class="rate-foot">
          <button class="ps-btn ghost" @click="ratingFor = null">取消</button>
          <button class="ps-btn" @click="submitRate">提交</button>
        </div>
      </div>
    </div>

    <!-- 插件详情页 -->
    <div v-if="detailFor" class="rate-overlay" @click.self="closeDetail">
      <div class="detail-modal">
        <div class="detail-head">
          <span class="ps-detail-ico">{{ detailFor.category === '效率' ? '⏱️' : detailFor.category === '工具' ? '🧰' : '🛍️' }}</span>
          <div class="detail-title-wrap">
            <div class="detail-title">{{ detailFor.title }}</div>
            <div class="detail-cat">{{ detailFor.category }} · {{ detailFor.author }} · v{{ detailFor.installed ? detailFor.installedVersion : detailFor.version }}</div>
          </div>
          <button class="rate-close" @click="closeDetail">×</button>
        </div>

        <div class="detail-screens">
          <template v-if="detailFor.screenshots?.length">
            <img
              v-for="(s, i) in detailFor.screenshots"
              :key="i"
              :src="s"
              class="detail-shot-img"
              alt="截图"
            />
          </template>
          <template v-else>
            <div class="detail-shot shot1">截图占位 A</div>
            <div class="detail-shot shot2">截图占位 B</div>
          </template>
        </div>

        <div class="detail-body">
          <p class="detail-desc">{{ detailFor.description }}</p>
          <div class="detail-rating">
            <span class="detail-stars">{{ stars(detailFor.rating) }}</span>
            <span class="detail-count">{{ detailFor.ratingCount ?? 0 }} 条评价</span>
          </div>
          <div v-if="detailFor.reviews?.length" class="detail-reviews">
            <div class="detail-reviews-title">用户评价</div>
            <div v-for="r in detailFor.reviews" :key="r.id" class="detail-review">
              <span class="dr-author">{{ r.author }}</span>
              <span class="dr-stars">{{ stars(r.score) }}</span>
              <span class="dr-comment">{{ r.comment }}</span>
            </div>
          </div>
        </div>

        <div class="detail-foot">
          <template v-if="!detailFor.installed">
            <button class="ps-btn" :disabled="busy === detailFor.name" @click="install(detailFor)">安装</button>
          </template>
          <template v-else>
            <button v-if="canUpdate(detailFor)" class="ps-btn" :disabled="busy === detailFor.name" @click="doUpdate(detailFor)">更新</button>
            <button v-else class="ps-btn ok" disabled>已安装</button>
            <button v-if="isThirdParty(detailFor)" class="ps-btn ghost" :disabled="busy === detailFor.name" @click="doExport(detailFor)">导出</button>
            <button class="ps-btn danger" :disabled="busy === detailFor.name" @click="doUninstall(detailFor)">卸载</button>
          </template>
          <button class="ps-btn ghost" @click="openRate(detailFor)">写评价</button>
          <button class="ps-btn ghost" @click="closeDetail">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-store { max-width: 900px; margin: 0 auto; padding: 16px; }
.ps-head h3 { margin: 0 0 4px; }
.ps-sub { font-size: 13px; color: var(--muted); }
.ps-tools { margin-top: 12px; display: flex; gap: 8px; }
.ps-search {
  flex: 1; padding: 9px 12px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 14px; font-family: inherit; background: var(--bg); color: var(--text);
}
.ps-btn.import { flex: none; padding: 0 14px; }
.ps-notice { margin-top: 8px; font-size: 13px; color: var(--ok); }
.ps-error { margin-top: 8px; font-size: 13px; color: var(--danger); }
.ps-cats { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.ps-cat-chip {
  padding: 5px 12px; border: 1px solid var(--border); border-radius: 999px;
  font-size: 12px; color: var(--muted); cursor: pointer; font-family: inherit;
}
.ps-cat-chip.on { background: var(--primary); border-color: var(--primary); color: #fff; }
.ps-rating { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ps-stars { color: #f59e0b; font-size: 13px; }
.ps-rating-count { font-size: 11px; color: var(--muted); }
.ps-reviews { margin-top: 6px; }
.ps-review { display: flex; gap: 6px; font-size: 11px; color: var(--muted); margin-top: 2px; }
.ps-review-author { font-weight: 600; color: var(--text); }
.ps-review-stars { color: #f59e0b; }
.ps-review-text { flex: 1; }
.ps-more { display: inline-block; font-size: 11px; color: var(--primary-dark); cursor: pointer; margin-top: 4px; }
.ps-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.rate-overlay {
  position: fixed; inset: 0; z-index: 600; background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.rate-modal {
  width: 380px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 18px;
}
.rate-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 14px; }
.rate-close { border: none; background: transparent; color: var(--muted); font-size: 20px; cursor: pointer; }
.rate-stars { display: flex; gap: 4px; margin: 12px 0; }
.rate-star { border: none; background: transparent; font-size: 28px; color: #cbd5e1; cursor: pointer; }
.rate-star.on { color: #f59e0b; }
.rate-comment { width: 100%; min-height: 80px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: inherit; }
.rate-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.detail-modal {
  width: 560px; max-height: 80vh; overflow-y: auto; background: var(--panel);
  border: 1px solid var(--border); border-radius: 14px; padding: 18px;
}
.detail-head { display: flex; align-items: center; gap: 12px; }
.ps-detail-ico { font-size: 30px; }
.detail-title-wrap { flex: 1; }
.detail-title { font-size: 16px; font-weight: 600; }
.detail-cat { font-size: 12px; color: var(--muted); margin-top: 2px; }
.detail-screens { display: flex; gap: 8px; margin-top: 14px; }
.detail-shot {
  flex: 1; height: 110px; border: 1px dashed var(--border); border-radius: 10px;
  display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px;
  background: var(--bg);
}
.detail-shot.shot1 { background: linear-gradient(135deg, #eef2ff, #dbeafe); }
.detail-shot.shot2 { background: linear-gradient(135deg, #fef3c7, #fde68a); }
.detail-shot.shot3 { background: linear-gradient(135deg, #ecfdf5, #d1fae5); }
.detail-shot-img {
  flex: 1; height: 130px; object-fit: cover; border-radius: 10px;
  border: 1px solid var(--border);
}
.detail-body { margin-top: 12px; }
.detail-desc { font-size: 13px; color: var(--text); line-height: 1.6; }
.detail-rating { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.detail-stars { color: #f59e0b; }
.detail-count { font-size: 12px; color: var(--muted); }
.detail-reviews { margin-top: 8px; }
.detail-reviews-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.detail-review { display: flex; gap: 8px; font-size: 12px; color: var(--muted); margin-top: 4px; }
.dr-author { font-weight: 600; color: var(--text); }
.dr-stars { color: #f59e0b; }
.dr-comment { flex: 1; }
.detail-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.ps-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-top: 16px; }
.ps-card {
  border: 1px solid var(--border); border-radius: 12px; padding: 14px;
  background: var(--panel); display: flex; flex-direction: column;
}
.ps-card-top { display: flex; align-items: center; justify-content: space-between; }
.ps-ico { font-size: 24px; }
.ps-cat { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: var(--primary-dark); }
.ps-title { font-size: 15px; font-weight: 600; margin-top: 6px; }
.ps-desc { font-size: 12px; color: var(--muted); margin-top: 4px; flex: 1; min-height: 32px; }
.ps-meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 11px; color: var(--muted); }
.ps-author { margin-right: auto; }
.ps-source { padding: 1px 7px; border-radius: 999px; font-size: 10px; white-space: nowrap; }
.ps-source.remote { background: #ecfdf5; color: #059669; }
.ps-source.local { background: #eff6ff; color: #2563eb; }
.ps-actions { display: flex; gap: 6px; margin-top: 10px; }
.ps-btn {
  flex: 1; border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.ps-btn:disabled { opacity: 0.6; }
.ps-btn.ok { border-color: var(--border); background: var(--panel); color: var(--muted); }
.ps-btn.danger { border-color: var(--danger); background: var(--panel); color: var(--danger); }
.ps-empty { grid-column: 1 / -1; text-align: center; color: var(--muted); padding: 24px; }
</style>
