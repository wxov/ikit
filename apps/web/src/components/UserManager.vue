<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  listUsers,
  createUser,
  disableUser,
  deleteUser,
  setUserRole,
  setUserGroups,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupParent,
  type PublicUser,
  type Group,
} from '../lib/auth'

const users = ref<PublicUser[]>([])
const groups = ref<Group[]>([])
const notice = ref('')
const error = ref('')

// ---- 添加用户 ----
const showAdd = ref(false)
const nUsername = ref('')
const nPassword = ref('')
const nRole = ref<'user' | 'admin'>('user')
const nGroupIds = ref<string[]>([])

// ---- 用户组管理 ----
const newGroupName = ref('')
const newGroupParent = ref('')
const renamingId = ref('')
const renameInput = ref('')

// ---- 用户组分配 ----
const editingUser = ref('')
const userGroupSel = ref<string[]>([])

function groupName(ids?: string[]): string {
  if (!ids?.length) return '注册用户'
  const names = ids.map((id) => groups.value.find((g) => g.id === id)?.name ?? id)
  return names.join('、')
}

async function load() {
  const r = await listUsers()
  users.value = r.users
  try {
    const g = await listGroups()
    groups.value = g.groups
  } catch {
    groups.value = []
  }
}

function toggleGroup(gid: string) {
  const next = new Set(nGroupIds.value)
  if (next.has(gid)) next.delete(gid)
  else next.add(gid)
  nGroupIds.value = [...next]
}

async function addUser() {
  error.value = ''
  notice.value = ''
  try {
    const r = await createUser(nUsername.value, nPassword.value, nRole.value, nGroupIds.value)
    users.value = r.users
    notice.value = `已添加用户「${r.user.username}」`
    nUsername.value = ''
    nPassword.value = ''
    nRole.value = 'user'
    nGroupIds.value = []
    showAdd.value = false
  } catch (e: any) {
    error.value = e.message
  }
}

async function toggleDisable(u: PublicUser) {
  const r = await disableUser(u.id, !u.disabled)
  users.value = r.users
}
async function remove(u: PublicUser) {
  const r = await deleteUser(u.id)
  users.value = r.users
}
async function toggleRole(u: PublicUser) {
  const r = await setUserRole(u.id, u.role === 'admin' ? 'user' : 'admin')
  users.value = r.users
}

// ---- 用户组 ----
async function addGroup() {
  error.value = ''
  if (!newGroupName.value.trim()) return
  try {
    const r = await createGroup(newGroupName.value.trim(), undefined, newGroupParent.value || undefined)
    groups.value = r.groups
    newGroupName.value = ''
    newGroupParent.value = ''
    notice.value = '已创建用户组'
  } catch (e: any) {
    error.value = e.message
  }
}

// ---- 组的包含关系（上级组包含下级组） ----
function groupDescendants(g: Group): Set<string> {
  const out = new Set<string>()
  const q = [g.id]
  while (q.length) {
    const cur = q.shift()!
    for (const x of groups.value) {
      if (x.parentId === cur && !out.has(x.id)) {
        out.add(x.id)
        q.push(x.id)
      }
    }
  }
  return out
}
function groupDepth(g: Group): number {
  let d = 0
  let cur = g
  const seen = new Set<string>()
  while (cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId)
    d++
    const p = groups.value.find((x) => x.id === cur.parentId)
    if (!p) break
    cur = p
  }
  return d
}
const orderedGroups = computed<Group[]>(() => {
  const out: Group[] = []
  const walk = (g: Group) => {
    out.push(g)
    groups.value.filter((x) => x.parentId === g.id).forEach(walk)
  }
  groups.value.filter((g) => !g.parentId).forEach(walk)
  return out
})
function allowedParents(g: Group): Group[] {
  const desc = groupDescendants(g)
  desc.add(g.id)
  return groups.value.filter((x) => !x.builtin && !desc.has(x.id))
}
async function setParent(g: Group, parentId: string) {
  try {
    const r = await setGroupParent(g.id, parentId || null)
    groups.value = r.groups
    notice.value = '已更新父组'
  } catch (e: any) {
    error.value = e.message
  }
}
function onGroupParentChange(g: Group, ev: Event) {
  setParent(g, (ev.target as HTMLSelectElement).value)
}
async function doRename(g: Group) {
  error.value = ''
  if (!renameInput.value.trim()) return
  try {
    const r = await renameGroup(g.id, renameInput.value.trim())
    groups.value = r.groups
    renamingId.value = ''
    notice.value = '已重命名'
  } catch (e: any) {
    error.value = e.message
  }
}
async function doDeleteGroup(g: Group) {
  if (!confirm(`删除用户组「${g.name}」？组内用户将回落至「注册用户」组。`)) return
  try {
    const r = await deleteGroup(g.id)
    groups.value = r.groups
    await load()
    notice.value = '已删除用户组'
  } catch (e: any) {
    error.value = e.message
  }
}

// ---- 用户组分配 ----
function openUserGroups(u: PublicUser) {
  editingUser.value = editingUser.value === u.id ? '' : u.id
  userGroupSel.value = [...(u.groupIds?.length ? u.groupIds : ['user'])]
}
function toggleUserGroup(gid: string) {
  const next = new Set(userGroupSel.value)
  if (next.has(gid)) next.delete(gid)
  else next.add(gid)
  userGroupSel.value = [...next]
}
async function saveUserGroups(u: PublicUser) {
  try {
    const r = await setUserGroups(u.id, userGroupSel.value)
    users.value = r.users
    editingUser.value = ''
    notice.value = '已更新用户组'
  } catch (e: any) {
    error.value = e.message
  }
}

onMounted(load)
</script>

<template>
  <div class="user-manager">
    <div class="um-head">
      <h3>用户管理</h3>
      <span class="um-sub">添加 / 禁用 / 删除 / 角色与用户组调整（仅站主可见；注册已屏蔽）</span>
    </div>

    <!-- 用户组管理 -->
    <div class="um-card">
      <h4>用户组</h4>
      <p class="um-sub">内置组「游客 / 注册用户 / 站主」默认存在且不可删除；自定义组支持「包含关系」（上级组包含下级组，上级组成员自动获得下级组权限）。</p>
      <div class="um-group-toolbar">
        <input v-model="newGroupName" class="um-input" placeholder="新组名，如：会员" @keydown.enter="addGroup" />
        <select v-model="newGroupParent" class="um-input">
          <option value="">顶层（无父组）</option>
          <option v-for="g in groups" :key="g.id" :value="g.id" :disabled="g.builtin">{{ g.name }}</option>
        </select>
        <button class="um-btn primary" :disabled="!newGroupName.trim()" @click="addGroup">+ 新建组</button>
      </div>
      <div v-if="orderedGroups.length" class="um-group-list">
        <div v-for="g in orderedGroups" :key="g.id" class="um-group-item" :style="{ marginLeft: groupDepth(g) * 16 + 'px' }">
          <span v-if="g.parentId" class="um-group-lvl">└</span>
          <span class="um-group-name">{{ g.name }}</span>
          <span v-if="g.builtin" class="um-group-builtin">内置</span>
          <span class="um-group-desc">{{ g.description || '' }}</span>
          <div class="um-group-actions">
            <template v-if="renamingId === g.id">
              <input v-model="renameInput" class="um-input small" placeholder="新组名" @keydown.enter="doRename(g)" />
              <button class="um-btn" @click="doRename(g)">确定</button>
            </template>
            <template v-else>
              <select v-if="!g.builtin" class="um-input small" :value="g.parentId || ''" @change="onGroupParentChange(g, $event)">
                <option value="">顶层</option>
                <option v-for="p in allowedParents(g)" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <button v-if="!g.builtin" class="um-btn" @click="renamingId = g.id; renameInput = g.name">重命名</button>
              <button v-if="!g.builtin" class="um-btn danger" @click="doDeleteGroup(g)">删除</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="um-toolbar">
      <button class="um-btn primary" @click="showAdd = !showAdd">{{ showAdd ? '收起' : '+ 添加用户' }}</button>
    </div>
    <div v-if="showAdd" class="um-add">
      <label>用户名</label>
      <input v-model="nUsername" class="um-input" placeholder="登录用户名" />
      <label>密码</label>
      <input v-model="nPassword" type="password" class="um-input" placeholder="至少 6 位" @keydown.enter="addUser" />
      <label>角色</label>
      <select v-model="nRole" class="um-input">
        <option value="user">普通用户</option>
        <option value="admin">站主</option>
      </select>
      <label>用户组</label>
      <div class="um-add-groups">
        <label v-for="g in groups" :key="g.id" class="um-add-group" :class="{ on: nGroupIds.includes(g.id) }">
          <input type="checkbox" :checked="nGroupIds.includes(g.id)" @change="toggleGroup(g.id)" />
          {{ g.name }}
        </label>
      </div>
      <button class="um-btn primary" :disabled="!nUsername || !nPassword" @click="addUser">创建</button>
    </div>

    <div v-if="notice" class="um-notice ok">{{ notice }}</div>
    <div v-if="error" class="um-notice bad">{{ error }}</div>
    <div v-if="!users.length" class="um-empty">暂无用户</div>
    <div v-else class="um-list">
      <div v-for="u in users" :key="u.id" class="um-item">
        <span class="um-name">{{ u.username }}</span>
        <span class="um-role" :class="{ admin: u.role === 'admin' }">{{ u.role === 'admin' ? '站主' : '用户' }}</span>
        <span class="um-group">{{ u.role === 'admin' ? '全部权限' : groupName(u.groupIds) }}</span>
        <span class="um-status" :class="{ off: u.disabled }">{{ u.disabled ? '已禁用' : '正常' }}</span>
        <div class="um-actions">
          <button class="um-btn" @click="toggleRole(u)">{{ u.role === 'admin' ? '降为用户' : '设为站主' }}</button>
          <button v-if="u.role !== 'admin'" class="um-btn secondary" @click="openUserGroups(u)">编辑组</button>
          <button class="um-btn secondary" @click="toggleDisable(u)">{{ u.disabled ? '启用' : '禁用' }}</button>
          <button class="um-btn danger" @click="remove(u)">删除</button>
        </div>
        <div v-if="editingUser === u.id" class="um-user-groups">
          <label v-for="g in groups" :key="g.id" class="um-add-group" :class="{ on: userGroupSel.includes(g.id) }">
            <input type="checkbox" :checked="userGroupSel.includes(g.id)" @change="toggleUserGroup(g.id)" />
            {{ g.name }}
          </label>
          <button class="um-btn primary" @click="saveUserGroups(u)">保存组</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-manager { max-width: 900px; margin: 0 auto; padding: 16px; }
.um-head h3 { margin: 0 0 4px; }
.um-sub { font-size: 13px; color: var(--muted); }
.um-card { margin-top: 16px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.um-card h4 { margin: 0 0 4px; }
.um-group-toolbar { display: flex; gap: 8px; margin-top: 10px; }
.um-group-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.um-group-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.um-group-name { font-weight: 600; font-size: 14px; }
.um-group-lvl { color: var(--muted); font-size: 12px; }
.um-group-builtin { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #eef2ff; color: var(--primary-dark); }
.um-group-desc { font-size: 12px; color: var(--muted); }
.um-group-actions { margin-left: auto; display: flex; gap: 6px; }
.um-toolbar { margin-top: 12px; }
.um-empty, .um-notice { margin-top: 12px; color: var(--muted); font-size: 13px; }
.um-notice.ok { color: var(--ok); }
.um-notice.bad { color: var(--danger); }
.um-add {
  display: grid; grid-template-columns: 90px 1fr; gap: 8px 10px; align-items: center;
  margin-top: 12px; padding: 14px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg);
}
.um-add label { font-size: 12px; color: var(--muted); }
.um-add .um-btn.primary { grid-column: 2; justify-self: start; }
.um-add-groups { display: flex; flex-wrap: wrap; gap: 6px; }
.um-add-group {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px;
  font-size: 12px; cursor: pointer; color: var(--muted);
}
.um-add-group.on { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-dark); }
.um-add-group input { accent-color: var(--primary); }
.um-input {
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; font-family: inherit; background: var(--panel); color: var(--text);
}
.um-input.small { padding: 5px 8px; font-size: 12px; }
.um-btn.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.um-list { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.um-item {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px;
}
.um-name { font-weight: 600; font-size: 14px; }
.um-role { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: var(--primary-dark); }
.um-role.admin { background: #fef3c7; color: #d97706; }
.um-group { font-size: 12px; color: var(--muted); }
.um-status { font-size: 12px; color: var(--muted); }
.um-status.off { color: var(--danger); }
.um-actions { margin-left: auto; display: flex; gap: 6px; }
.um-user-groups { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.um-btn { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
.um-btn.secondary { color: var(--muted); }
.um-btn.danger { color: var(--danger); border-color: var(--danger); }
</style>
