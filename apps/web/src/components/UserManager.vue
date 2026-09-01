<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { listUsers, createUser, disableUser, deleteUser, setUserRole, type PublicUser } from '../lib/auth'

const users = ref<PublicUser[]>([])
const notice = ref('')
const error = ref('')
const showAdd = ref(false)
const nUsername = ref('')
const nPassword = ref('')
const nRole = ref<'user' | 'admin'>('user')

async function load() {
  const r = await listUsers()
  users.value = r.users
}
async function addUser() {
  error.value = ''
  notice.value = ''
  try {
    const r = await createUser(nUsername.value, nPassword.value, nRole.value)
    users.value = r.users
    notice.value = `已添加用户「${r.user.username}」`
    nUsername.value = ''
    nPassword.value = ''
    nRole.value = 'user'
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
onMounted(load)
</script>

<template>
  <div class="user-manager">
    <div class="um-head">
      <h3>用户管理</h3>
      <span class="um-sub">添加 / 禁用 / 删除 / 角色调整（仅站主可见；注册已屏蔽，账号由站主手动添加）</span>
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
      <button class="um-btn primary" :disabled="!nUsername || !nPassword" @click="addUser">创建</button>
    </div>
    <div v-if="notice" class="um-notice ok">{{ notice }}</div>
    <div v-if="error" class="um-notice bad">{{ error }}</div>
    <div v-if="!users.length" class="um-empty">暂无用户</div>
    <div v-else class="um-list">
      <div v-for="u in users" :key="u.id" class="um-item">
        <span class="um-name">{{ u.username }}</span>
        <span class="um-role" :class="{ admin: u.role === 'admin' }">{{ u.role === 'admin' ? '站主' : '用户' }}</span>
        <span class="um-status" :class="{ off: u.disabled }">{{ u.disabled ? '已禁用' : '正常' }}</span>
        <div class="um-actions">
          <button class="um-btn" @click="toggleRole(u)">{{ u.role === 'admin' ? '降为用户' : '设为站主' }}</button>
          <button class="um-btn secondary" @click="toggleDisable(u)">{{ u.disabled ? '启用' : '禁用' }}</button>
          <button class="um-btn danger" @click="remove(u)">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-manager { max-width: 800px; margin: 0 auto; padding: 16px; }
.um-head h3 { margin: 0 0 4px; }
.um-sub { font-size: 13px; color: var(--muted); }
.um-toolbar { margin-top: 12px; }
.um-empty, .um-notice { margin-top: 12px; color: var(--muted); font-size: 13px; }
.um-notice.ok { color: var(--ok); }
.um-notice.bad { color: var(--danger); }
.um-add {
  display: grid; grid-template-columns: 90px 1fr auto; gap: 8px 10px; align-items: center;
  margin-top: 12px; padding: 14px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg);
}
.um-add label { font-size: 12px; color: var(--muted); }
.um-add label:nth-of-type(3) { grid-column: 1; }
.um-input {
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; font-family: inherit; background: var(--panel); color: var(--text);
}
.um-btn.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.um-list { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.um-item {
  display: flex; align-items: center; gap: 12px;
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px;
}
.um-name { font-weight: 600; font-size: 14px; }
.um-role { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: var(--primary-dark); }
.um-role.admin { background: #fef3c7; color: #d97706; }
.um-status { font-size: 12px; color: var(--muted); }
.um-status.off { color: var(--danger); }
.um-actions { margin-left: auto; display: flex; gap: 6px; }
.um-btn { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
.um-btn.secondary { color: var(--muted); }
.um-btn.danger { color: var(--danger); border-color: var(--danger); }
</style>
