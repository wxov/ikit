<script setup lang="ts">
import { ref, computed, inject, onMounted, type ComputedRef } from 'vue'
import {
  fetchAllPlugins,
  setPluginEnabled,
  setPluginOrder,
  setPluginGroups,
  uninstallPlugin,
  type PluginRecord,
} from '../lib/plugins'
import { listGroups, type Group } from '../lib/auth'

const plugins = ref<PluginRecord[]>([])
const groups = ref<Group[]>([])
const loading = ref(false)
const notice = ref('')
const error = ref('')
const saving = ref(false)
// 拖拽态：拖动中乐观改序（即时预览），dragend 提交；失败/取消回滚 baseline
const dragIndex = ref(-1)
const dragging = ref(false)
let baseline: string[] | null = null

// admin 三重门控之一：注 App.vue 的 userRole（另两层：页面门控 + 后端 403）
const userRole = inject<ComputedRef<string>>('userRole', computed(() => 'guest'))
const isAdmin = computed(() => userRole.value === 'admin')
// 与 App.vue 的顶部 nav / 移动端 tabbar 顺序联动（无 provider 时降级为仅本列表预览）
const orderSync = inject<{ preview(names: string[]): void; refresh(): void } | null>('pluginOrderSync', null)

// ---- 删除插件（2026-11-25）：与商店卸载同一接口（DELETE /api/plugin-store/:name），
// 后端会 dispose 实例 + 物理删除插件目录（目录名/manifest 名不一致时按目录名兜底），避免重启后被 loadAll 重新扫描注册。
// 用应用内确认替代 window.confirm（桌面/移动 webview 常屏蔽原生 confirm，导致点击无反应）。
const confirmDelete = ref<PluginRecord | null>(null)
const deleting = ref(false)

function askDelete(p: PluginRecord) {
  if (p.builtin) {
    error.value = '内置插件不可删除'
    return
  }
  error.value = ''
  notice.value = ''
  confirmDelete.value = p
}

function cancelDelete() {
  confirmDelete.value = null
}

async function doDelete() {
  const p = confirmDelete.value
  if (!p || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await uninstallPlugin(p.name)
    confirmDelete.value = null
    notice.value = `已删除插件「${p.title}」`
    await load()
    orderSync?.refresh() // 顶部 nav / 移动端 tab 立即去掉该插件入口
  } catch (e: any) {
    error.value = e?.message ?? String(e)
  } finally {
    deleting.value = false
  }
}

/** 按 order 升序归一化：后端 list()/setOrder() 返回的是未排序的原始数组（历史 bug：拖完跳回） */
function normalize(list: PluginRecord[]): PluginRecord[] {
  return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
function namesOf(): string[] {
  return plugins.value.map((p) => p.name)
}

async function load() {
  loading.value = true
  try {
    const r = await fetchAllPlugins()
    // 拖拽期间忽略响应，避免异步返回覆盖即时预览
    if (dragging.value) return
    plugins.value = normalize(r.plugins)
    try {
      const g = await listGroups()
      groups.value = g.groups
    } catch {
      groups.value = []
    }
  } catch (e: any) {
    notice.value = e.message
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(p: PluginRecord) {
  const r = await setPluginEnabled(p.name, !p.enabled)
  plugins.value = normalize(r.plugins)
}

async function toggleGroup(p: PluginRecord, gid: string) {
  const next = new Set(p.visibleGroups)
  if (next.has(gid)) next.delete(gid)
  else next.add(gid)
  const r = await setPluginGroups(p.name, [...next])
  plugins.value = normalize(r.plugins)
}

/** 本地乐观改序（即时预览）：列表 + nav 同步，不发请求 */
function previewMove(from: number, to: number) {
  const list = [...plugins.value]
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  list.forEach((p, i) => {
    p.order = i
  })
  plugins.value = list
  orderSync?.preview(list.map((p) => p.name))
}

/** 按名字序列恢复顺序（回滚用） */
function restore(names: string[]) {
  const byName = new Map(plugins.value.map((p) => [p.name, p]))
  const used = new Set<string>()
  const list: PluginRecord[] = []
  names.forEach((n, i) => {
    const p = byName.get(n)
    if (p) {
      p.order = i
      list.push(p)
      used.add(n)
    }
  })
  // baseline 未覆盖的插件（如期间新装）按原 order 追加，避免丢失
  for (const p of plugins.value) if (!used.has(p.name)) list.push(p)
  plugins.value = list
  orderSync?.preview(list.map((p) => p.name))
}

/** 提交排序（唯一提交点）：成功用服务端结果归一化，失败回滚列表 + nav */
async function commit() {
  const names = namesOf()
  const base = baseline
  baseline = null
  if (!base || base.join('\u0000') === names.join('\u0000')) return // 未移动：no-op，不发请求
  saving.value = true
  error.value = ''
  try {
    const r = await setPluginOrder(names)
    plugins.value = normalize(r.plugins)
    orderSync?.refresh()
  } catch (e: any) {
    restore(base)
    error.value = `排序保存失败：${e?.message ?? e}`
  } finally {
    saving.value = false
  }
}

function cancel() {
  if (!baseline) return
  restore(baseline)
  baseline = null
}

function onDragStart(i: number, e: DragEvent) {
  if (!isAdmin.value || saving.value) return
  dragIndex.value = i
  dragging.value = true
  baseline = namesOf()
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 必须 setData 才会启动拖拽
    e.dataTransfer.setData('text/plain', plugins.value[i]?.name ?? '')
  }
}

function onDragOver(i: number, e: DragEvent) {
  if (!isAdmin.value || saving.value || dragIndex.value < 0) return
  e.preventDefault()
  if (dragIndex.value === i) return
  previewMove(dragIndex.value, i)
  dragIndex.value = i
}

function onDragEnd(e: DragEvent) {
  const cancelled = !e.dataTransfer || e.dataTransfer.dropEffect === 'none'
  dragging.value = false
  dragIndex.value = -1
  if (cancelled) cancel()
  else void commit()
}

/** ⬆/⬇（触控/键盘兜底）：同一乐观预览 + 提交/回滚通路 */
function step(i: number, dir: -1 | 1) {
  if (!isAdmin.value || saving.value) return
  const to = i + dir
  if (to < 0 || to >= plugins.value.length) return
  baseline = namesOf()
  previewMove(i, to)
  void commit()
}

onMounted(load)
</script>

<template>
  <div class="plugin-settings">
    <div class="ps-head">
      <h3>插件管理</h3>
      <span class="ps-sub">启用/禁用、拖拽排序、按用户组设置可见性（即时生效）</span>
    </div>
    <div v-if="notice" class="ps-notice">{{ notice }}</div>
    <div v-if="error" class="ps-error">{{ error }}</div>
    <div v-if="saving" class="ps-saving">保存中…</div>
    <div v-if="loading" class="ps-empty">加载中…</div>
    <div v-else-if="!plugins.length" class="ps-empty">暂无插件</div>
    <div v-else class="ps-list" @dragover.prevent>
      <div
        v-for="(p, i) in plugins"
        :key="p.name"
        class="ps-item"
        :class="{ dragging: dragging && dragIndex === i, saving }"
        :draggable="isAdmin"
        @dragstart="onDragStart(i, $event)"
        @dragover.prevent="onDragOver(i, $event)"
        @drop.prevent
        @dragend="onDragEnd($event)"
      >
        <div class="ps-item-head">
          <span class="ps-drag" :title="isAdmin ? '拖动排序（触控可用 ⬆/⬇）' : ''">⠿</span>
          <span class="ps-name">{{ p.title }}</span>
          <span v-if="p.builtin" class="ps-baged builtin">内置</span>
          <span class="ps-version">v{{ p.version }}</span>
          <span class="ps-order">{{ p.order }}</span>
          <span
            v-if="p.scanWarnings?.length"
            class="ps-risk"
            :title="`安全扫描警告 ${p.scanWarnings.length} 项：\n${p.scanWarnings.join('\n')}`"
            >⚠️{{ p.scanWarnings.length }}</span
          >
          <span class="ps-moves">
            <button
              class="ps-move"
              title="上移"
              :disabled="!isAdmin || saving || i === 0"
              @click="step(i, -1)"
            >⬆</button>
            <button
              class="ps-move"
              title="下移"
              :disabled="!isAdmin || saving || i === plugins.length - 1"
              @click="step(i, 1)"
            >⬇</button>
          </span>
          <button class="ps-switch" :class="{ on: p.enabled }" @click="toggleEnabled(p)">
            {{ p.enabled ? '启用' : '禁用' }}
          </button>
          <!-- 删除插件（内置插件不可删除）：连目录一起删，避免重启后重新注册 -->
          <button
            v-if="!p.builtin"
            class="ps-del"
            :disabled="!isAdmin || saving || deleting"
            title="删除该插件（含插件目录，不可恢复）"
            @click="askDelete(p)"
          >删除</button>
          <span v-else class="ps-del is-disabled" title="内置插件不可删除">删除</span>
        </div>
        <div class="ps-visibility">
          <span class="ps-vlabel">可见用户组</span>
          <div
            v-for="g in groups"
            :key="g.id"
            class="ps-role"
            :class="{ on: p.visibleGroups.includes(g.id) }"
            @click="toggleGroup(p, g.id)"
          >
            <span class="ps-role-check">{{ p.visibleGroups.includes(g.id) ? '✓' : '' }}</span>
            {{ g.name }}{{ g.builtin ? '·内置' : '' }}
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认：应用内弹窗（替代 window.confirm，桌面/移动 webview 均可点） -->
    <Teleport to="body">
      <div v-if="confirmDelete" class="ps-modal-mask" @click.self="cancelDelete">
        <div class="ps-modal" role="dialog" aria-label="确认删除插件">
          <div class="ps-modal-title">删除插件「{{ confirmDelete.title }}」？</div>
          <div class="ps-modal-body">
            将卸载并物理删除该插件目录（含 <code>{{ confirmDelete.name }}</code>），不可恢复。
            若只想停用，请用「{{ confirmDelete.enabled ? '禁用' : '启用' }}」开关。
          </div>
          <div v-if="error" class="ps-modal-error">{{ error }}</div>
          <div class="ps-modal-actions">
            <button class="ps-modal-btn" :disabled="deleting" @click="cancelDelete">取消</button>
            <button class="ps-modal-btn danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? '删除中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.plugin-settings {
  max-width: 860px;
  margin: 0 auto;
  padding: 16px;
}
.ps-head h3 {
  margin: 0 0 4px;
}
.ps-sub {
  font-size: 13px;
  color: var(--muted);
}
.ps-notice,
.ps-empty {
  margin-top: 12px;
  color: var(--muted);
  font-size: 13px;
}
.ps-error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 13px;
}
.ps-saving {
  margin-top: 12px;
  color: var(--muted);
  font-size: 13px;
}
.ps-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}
.ps-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--panel);
}
.ps-item.dragging {
  opacity: 0.5;
}
.ps-item.saving {
  border-style: dashed;
}
.ps-moves {
  display: inline-flex;
  gap: 2px;
}
.ps-move {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: 6px;
  padding: 1px 6px;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  font-family: inherit;
}
.ps-move:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ps-risk {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  cursor: help;
  white-space: nowrap;
}
.ps-item-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ps-drag {
  cursor: grab;
  color: var(--muted);
}
.ps-name {
  font-weight: 600;
  font-size: 14px;
}
.ps-baged {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
}
.ps-baged.builtin {
  background: #eef2ff;
  color: var(--primary-dark);
}
.ps-version {
  font-size: 12px;
  color: var(--muted);
}
.ps-order {
  font-size: 12px;
  color: var(--muted);
}
.ps-switch {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.ps-switch.on {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.ps-visibility {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.ps-vlabel {
  font-size: 12px;
  color: var(--muted);
}
.ps-role {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
  color: var(--muted);
}
.ps-role.on {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary-dark);
  font-weight: 500;
}
.ps-role-check {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--primary-dark);
}

/* ---- 删除插件按钮 + 应用内确认弹窗（2026-11-25） ---- */
.ps-del {
  margin-left: 6px;
  padding: 4px 10px;
  border: 1px solid var(--danger, #dc2626);
  border-radius: 8px;
  background: transparent;
  color: var(--danger, #dc2626);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  flex: 0 0 auto;
}
.ps-del:hover:not(:disabled) { background: rgba(220, 38, 38, 0.08); }
.ps-del:disabled, .ps-del.is-disabled { opacity: 0.45; cursor: not-allowed; }
.ps-modal-mask {
  position: fixed; inset: 0; z-index: 1200;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.ps-modal {
  width: min(420px, 100%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 18px 14px;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
}
.ps-modal-title { font-size: 15px; font-weight: 700; color: var(--text); }
.ps-modal-body { margin-top: 8px; font-size: 13px; line-height: 1.7; color: var(--muted); }
.ps-modal-body code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.ps-modal-error { margin-top: 8px; font-size: 12px; color: var(--danger, #dc2626); }
.ps-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.ps-modal-btn {
  padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel); color: var(--text); font-size: 13px; font-family: inherit; cursor: pointer;
}
.ps-modal-btn.danger { border-color: var(--danger, #dc2626); background: var(--danger, #dc2626); color: #fff; }
.ps-modal-btn:disabled { opacity: 0.6; cursor: default; }
</style>
