<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  fetchAllPlugins,
  setPluginEnabled,
  setPluginOrder,
  setPluginGroups,
  type PluginRecord,
} from '../lib/plugins'
import { listGroups, type Group } from '../lib/auth'

const plugins = ref<PluginRecord[]>([])
const groups = ref<Group[]>([])
const loading = ref(false)
const notice = ref('')

async function load() {
  loading.value = true
  try {
    const r = await fetchAllPlugins()
    plugins.value = r.plugins
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
  plugins.value = r.plugins
}

async function toggleGroup(p: PluginRecord, gid: string) {
  const next = new Set(p.visibleGroups)
  if (next.has(gid)) next.delete(gid)
  else next.add(gid)
  const r = await setPluginGroups(p.name, [...next])
  plugins.value = r.plugins
}

let dragIndex = -1
function onDragStart(i: number) {
  dragIndex = i
}
async function onDrop(i: number, p: PluginRecord) {
  if (dragIndex < 0 || dragIndex === i) return
  const ordered = plugins.value.map((x) => x.name)
  const [moved] = ordered.splice(dragIndex, 1)
  ordered.splice(i, 0, moved)
  const r = await setPluginOrder(ordered)
  plugins.value = r.plugins
  dragIndex = -1
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
    <div v-if="loading" class="ps-empty">加载中…</div>
    <div v-else-if="!plugins.length" class="ps-empty">暂无插件</div>
    <div v-else class="ps-list">
      <div
        v-for="(p, i) in plugins"
        :key="p.name"
        class="ps-item"
        draggable="true"
        @dragstart="onDragStart(i)"
        @dragover.prevent
        @drop="onDrop(i, p)"
      >
        <div class="ps-item-head">
          <span class="ps-drag">⠿</span>
          <span class="ps-name">{{ p.title }}</span>
          <span v-if="p.builtin" class="ps-baged builtin">内置</span>
          <span class="ps-version">v{{ p.version }}</span>
          <span class="ps-order">{{ p.order }}</span>
          <button class="ps-switch" :class="{ on: p.enabled }" @click="toggleEnabled(p)">
            {{ p.enabled ? '启用' : '禁用' }}
          </button>
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
</style>
