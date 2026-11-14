import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor 移动端配置
// 复用同一套 Vue 前端，构建产物（dist）打包进原生 App
const config: CapacitorConfig = {
  appId: 'io.ikit.app',
  appName: 'i-kit',
  webDir: 'dist',
  server: {
    // 允许 http 明文（局域网后端 API），生产建议 https
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    // targetSdk 35（Android 15）强制 edge-to-edge 的兜底（Capacitor 7.6+ 内置能力，无需新依赖）：
    // auto = 仅当系统「强制」edge-to-edge（主题 opt-out 未生效）时，把 systemBars + displayCutout 的 insets
    // 作为 WebView 的外边距，避免顶栏被状态栏、底栏被手势条遮挡；主题 opt-out 生效时不会重复留白。
    // 对应原生实现见 node_modules/@capacitor/android/.../CapacitorWebView.java#edgeToEdgeHandler。
    adjustMarginsForEdgeToEdge: 'auto',
  },
  ios: {
    // 允许 http 明文请求
    limitsNavigationsToAppBoundDomains: false,
  },
}

export default config
