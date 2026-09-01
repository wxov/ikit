<script setup lang="ts">
import { ref } from 'vue'
import { login, requestReset, resetPassword, setToken } from '../lib/auth'

const emit = defineEmits<{ (e: 'authed', user: any): void }>()

const mode = ref<'login' | 'reset'>('login')
const username = ref('')
const password = ref('')
const resetToken = ref('')
const notice = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    if (mode.value === 'login') {
      const { token, user } = await login(username.value, password.value)
      setToken(token)
      emit('authed', user)
    } else if (mode.value === 'reset') {
      if (!resetToken.value) {
        const r = await requestReset(username.value)
        if (r.sent) {
          notice.value = '已发送重置邮件到该邮箱，请查收'
        } else if (r.resetToken) {
          resetToken.value = r.resetToken
          notice.value = '已生成重置码（未配置邮件，演示：见输入框）'
        } else {
          notice.value = '未找到该用户'
        }
      } else {
        const r = await resetPassword(resetToken.value, password.value)
        if (r.ok) {
          notice.value = '密码已重置，请登录'
          mode.value = 'login'
        }
      }
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="auth-panel">
    <div class="auth-card">
      <h3>{{ mode === 'login' ? '登录' : '找回密码' }}</h3>
      <div v-if="notice" class="auth-notice">{{ notice }}</div>
      <div v-if="error" class="auth-error">{{ error }}</div>

      <label>用户名</label>
      <input v-model="username" placeholder="用户名" @keydown.enter="submit" />

      <template v-if="mode !== 'reset' || resetToken">
        <label>密码</label>
        <input v-model="password" type="password" placeholder="密码（至少 6 位）" @keydown.enter="submit" />
      </template>
      <template v-if="mode === 'reset' && resetToken">
        <label>重置码</label>
        <input v-model="resetToken" placeholder="重置码" />
        <label>新密码</label>
        <input v-model="password" type="password" placeholder="新密码（至少 6 位）" @keydown.enter="submit" />
      </template>

      <button class="auth-btn" :disabled="busy" @click="submit">
        {{ busy ? '处理中…' : mode === 'login' ? '登录' : '重置密码' }}
      </button>

      <div class="auth-links">
        <a v-if="mode !== 'login'" @click="mode = 'login'; error = ''; notice = ''">返回登录</a>
        <a v-if="mode === 'login'" @click="mode = 'reset'; error = ''; notice = ''">忘记密码</a>
      </div>
      <div class="auth-hint">账号由站主创建；默认站主：admin / admin123</div>
    </div>
  </div>
</template>

<style scoped>
.auth-panel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}
.auth-card {
  width: 340px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
}
.auth-card h3 { margin: 0 0 14px; }
.auth-card label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
.auth-card input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  background: var(--bg);
  color: var(--text);
}
.auth-btn {
  width: 100%;
  margin-top: 16px;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.auth-btn:disabled { opacity: 0.6; }
.auth-links { display: flex; gap: 14px; margin-top: 12px; }
.auth-links a { font-size: 12px; color: var(--primary-dark); cursor: pointer; }
.auth-notice { font-size: 13px; color: var(--ok); margin-bottom: 8px; }
.auth-error { font-size: 13px; color: var(--danger); margin-bottom: 8px; }
.auth-hint { margin-top: 12px; font-size: 11px; color: var(--muted); }
</style>
