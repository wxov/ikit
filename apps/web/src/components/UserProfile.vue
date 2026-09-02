<script setup lang="ts">
import { ref, type Ref, inject } from 'vue'
import { api } from '../lib/api'
import { authHeaders, type PublicUser } from '../lib/auth'

const emit = defineEmits<{ (e: 'updated', user: PublicUser): void; (e: 'close'): void }>()
const user = inject<Ref<PublicUser | null>>('currentUser', ref(null))

const username = ref(user.value?.username ?? '')
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const notice = ref('')
const error = ref('')
const busy = ref(false)
const savingUser = ref(false)
const savingPass = ref(false)

async function saveUsername() {
  error.value = ''
  notice.value = ''
  if (!username.value.trim()) {
    error.value = '用户名不能为空'
    return
  }
  savingUser.value = true
  try {
    const r = await api<{ user: PublicUser }>('/api/auth/profile', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username: username.value.trim() }),
    })
    notice.value = `用户名已更新为「${r.user.username}」`
    emit('updated', r.user)
  } catch (e: any) {
    error.value = e.message
  } finally {
    savingUser.value = false
  }
}

async function savePassword() {
  error.value = ''
  notice.value = ''
  if (newPassword.value.length < 6) {
    error.value = '新密码至少 6 位'
    return
  }
  if (newPassword.value !== newPassword2.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  savingPass.value = true
  try {
    await api('/api/auth/profile', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value }),
    })
    notice.value = '密码修改成功'
    oldPassword.value = ''
    newPassword.value = ''
    newPassword2.value = ''
  } catch (e: any) {
    error.value = e.message
  } finally {
    savingPass.value = false
  }
}
</script>

<template>
  <div class="profile-overlay" @click.self="emit('close')">
    <div class="profile-panel">
      <header class="pp-head">
        <h3>编辑资料</h3>
        <button class="pp-x" @click="emit('close')">×</button>
      </header>
      <div v-if="notice" class="pp-notice ok">{{ notice }}</div>
      <div v-if="error" class="pp-notice bad">{{ error }}</div>

      <section class="pp-sec">
        <h4>修改用户名</h4>
        <div class="pp-row">
          <input v-model="username" class="pp-input" placeholder="新用户名" @keydown.enter="saveUsername" />
          <button class="pp-btn" :disabled="savingUser" @click="saveUsername">{{ savingUser ? '保存中…' : '保存用户名' }}</button>
        </div>
      </section>

      <section class="pp-sec">
        <h4>修改密码</h4>
        <input v-model="oldPassword" type="password" class="pp-input full" placeholder="原密码" />
        <input v-model="newPassword" type="password" class="pp-input full" placeholder="新密码（至少 6 位）" />
        <input v-model="newPassword2" type="password" class="pp-input full" placeholder="确认新密码" @keydown.enter="savePassword" />
        <button class="pp-btn" :disabled="savingPass" @click="savePassword">{{ savingPass ? '提交中…' : '修改密码' }}</button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.profile-overlay {
  position: fixed; inset: 0; z-index: 650;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.profile-panel {
  width: 420px; max-width: 100%;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 20px; display: flex; flex-direction: column; gap: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}
.pp-head { display: flex; align-items: center; justify-content: space-between; }
.pp-head h3 { margin: 0; }
.pp-x { border: none; background: transparent; color: var(--muted); font-size: 24px; cursor: pointer; line-height: 1; }
.pp-notice { font-size: 13px; }
.pp-notice.ok { color: var(--ok); }
.pp-notice.bad { color: var(--danger); }
.pp-sec { border-top: 1px solid var(--border); padding-top: 14px; }
.pp-sec h4 { margin: 0 0 10px; font-size: 13px; }
.pp-row { display: flex; gap: 8px; }
.pp-input {
  flex: 1; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; font-family: inherit; background: var(--bg); color: var(--text);
  margin-bottom: 8px;
}
.pp-input.full { width: 100%; }
.pp-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
.pp-btn:disabled { opacity: 0.6; }
</style>
