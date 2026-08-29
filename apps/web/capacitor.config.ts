import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor 移动端配置
// 复用同一套 Vue 前端，构建产物（dist）打包进原生 App
const config: CapacitorConfig = {
  appId: 'com.ikit.app',
  appName: 'i-kit',
  webDir: 'dist',
  server: {
    // 允许 http 明文（局域网后端 API），生产建议 https
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  ios: {
    // 允许 http 明文请求
    limitsNavigationsToAppBoundDomains: false,
  },
}

export default config
