# 三端互联（Web / 桌面 / 移动）

复用同一套 Vue 前端（`apps/web`）+ 同一套 REST + WebSocket 后端，实现 Web / Tauri 桌面 / Capacitor 移动三端互联。

## 架构

```
                 ┌─────────────────────────────┐
                 │  核心服务（Cordis + fastify）│
                 │  REST :3000 + WS + SSE      │
                 └──────────────┬──────────────┘
                                │ 统一 API / WS
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   ┌────▼────┐           ┌──────▼──────┐         ┌──────▼──────┐
   │ Web 端  │           │ 桌面端      │         │ 移动端      │
   │ 浏览器  │           │ Tauri 壳    │         │ Capacitor   │
   │ 同源/代理│          │ + Vue 前端  │         │ + Vue 前端  │
   └─────────┘           └─────────────┘         └─────────────┘
```

三端**共用同一份 `apps/web` 前端代码**，唯一差异是 **API 基地址**：

| 端 | API 基地址 | 说明 |
|---|---|---|
| Web | 空（相对路径） | dev 走 Vite proxy，生产同源部署 |
| 桌面（Tauri） | `http://localhost:3000`（或服务器地址） | 构建时注入 `VITE_API_BASE` |
| 移动（Capacitor） | `http://<局域网IP>:3000`（或服务器地址） | 构建时注入 `VITE_API_BASE` |

## API 地址配置

前端通过 `src/lib/config.ts` 统一处理 API/WS 地址，读取 Vite 环境变量 `VITE_API_BASE`：

```ts
// 空 → 相对路径（Web 端）；有值 → 绝对地址（桌面/移动端）
export const API_BASE = import.meta.env.VITE_API_BASE ?? ''
```

`api.ts` 的 REST 请求与 WebSocket 连接都经过 `apiUrl()` / `wsUrl()`，自动适配三端。

## 桌面端（Tauri 2）

### 前提条件

- [Rust 工具链](https://rustup.rs)（`rustup` + `cargo`）
- Windows：MSVC Build Tools + WebView2
- macOS：Xcode Command Line Tools
- Linux：`webkit2gtk` 等系统依赖

### 开发

```bash
cd apps/web

# 先启动后端（3000）
pnpm --filter @ikit/server dev

# Tauri dev 模式（会自动启动 Vite，加载 http://localhost:5173）
pnpm tauri dev
```

### 构建

```bash
cd apps/web

# 构建桌面安装包（API 指向 localhost:3000，可改 build:desktop 脚本里的地址）
pnpm tauri build
# 产物在 apps/web/src-tauri/target/release/
```

`tauri.conf.json` 的 `build.beforeBuildCommand` 已指向 `pnpm build:desktop`（注入 `VITE_API_BASE=http://localhost:3000`）。

> **离线资源（完善⑦，2026-10-13）**：`apps/web/dist` 现包含 **Vditor 编辑器的本地资源** `vditor/dist/**`
> （≈5.27 MB，含 Lute 引擎 / KaTeX / highlight.js / 内容主题 / emoji），编辑器**不依赖 unpkg CDN**，
> 断网 / 内网 / 桌面 / 移动端均可正常打开。资源由 `scripts/sync-vditor-assets.mjs` 幂等同步，
> 并在 `apps/web` 构建前经 `prebuild` 钩子自动执行（升级 `vditor` 版本后也可手动执行
> `pnpm --filter @ikit/web sync:vditor`）。**桌面/移动端正文与封面里的 `/uploads/...` 相对路径**
> 在跨域 `VITE_API_BASE` 下仍是既有缺陷（另立项），与本次资源本地化无关。

## 移动端（Capacitor）

### 前提条件

- Android：[Android Studio](https://developer.android.com/studio) + SDK + JDK 17+（仓库根附带本地工具链 `jdk21/` 可直接使用）
- iOS：Xcode（仅 macOS）

### 初始化原生工程（首次）

```bash
cd apps/web

# 构建前端（API 指向局域网 IP，需改成你后端的实际 IP）
# 先改 package.json 里 build:mobile 的 VITE_API_BASE
pnpm build:mobile

# 添加原生平台
pnpm cap:add:android    # 生成 android/ 目录
pnpm cap:add:ios        # 生成 ios/ 目录（仅 macOS）
```

### 构建 / 运行

```bash
cd apps/web

# 同步前端产物到原生工程
pnpm cap:sync

# 用 Android Studio 打开并运行
pnpm cap:open:android

# 或用 Xcode 打开（macOS）
pnpm cap:open:ios
```

## 移动端安全区与视口适配（2026-11-14，华为 Mate 60 Pro 等全面屏）

> 问题：顶部被状态栏/挖孔遮挡、底部被手势条遮挡、宽内容把整页撑出横向滚动条。
> 结论：Web 层统一 `viewport-fit=cover` + `env(safe-area-inset-*)` 变量；Android 原生层退出
> Android 15（targetSdk 35）强制 edge-to-edge，并保留 Capacitor 内置 insets 兜底。

### 1. viewport

`apps/web/index.html`：

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- **必须带 `viewport-fit=cover`**：否则 `env(safe-area-inset-*)` 恒为 `0`，下面所有安全区留白都会失效
  （此前 `App.vue` 里 `padding-bottom: env(safe-area-inset-bottom)` 实际无效正是这个原因）。
- 不写 `maximum-scale` / `user-scalable=no`，保留用户缩放（可访问性）。

### 2. 安全区 CSS 变量（`apps/web/src/style.css`）

```css
:root {
  --sat: env(safe-area-inset-top, 0px);
  --sab: env(safe-area-inset-bottom, 0px);
  --sal: env(safe-area-inset-left, 0px);
  --sar: env(safe-area-inset-right, 0px);
}
```

| 位置 | 规则 | 作用 |
|---|---|---|
| 顶栏 `.topbar` | `padding-top: var(--sat)`；`height: calc(60px + var(--sat))` | sticky 顶栏整体下移，状态栏/刘海不压内容；内容区仍按 60px 排 |
| 窄屏抽屉 `.portal-left/.portal-right` | `top: calc(60px + var(--sat))`；左右 `max(10px, var(--sal/--sar))`；`padding-bottom: max(12px, var(--sab))` | 抽屉不钻到状态栏/手势条下（含横屏刘海） |
| 底部 Tab `.bottom-tabbar` | `height:auto; min-height:56px; padding-bottom: max(4px, var(--sab)); padding-left/right: var(--sal/--sar)` | 手势条区域由 padding 让开，Tab 内容仍在 56px 基准线上 |
| 内容底部 | `.portal-main, main { padding-bottom: calc(72px + var(--sab)) }` | 最后一段内容不被固定 Tab / 手势条盖住 |
| 站主管理浮层 | `.mobile-admin-sheet { bottom: calc(64px + var(--sab)) }` | 浮层在 Tab 之上 |
| 中栏 `.portal` | `padding: 12px max(12px, var(--sar)) 12px max(12px, var(--sal))` | 横屏刘海 |

注意：`--sat/--sab/--sal/--sar` 在普通桌面浏览器 / 非全面屏设备上为 `0px`，布局与改前一致。

### 3. 横向溢出治理

- **整页兜底**：`html { overflow-x: hidden }` + `body { overflow-x: clip }`。`clip` **不创建 body 滚动容器**，
  窗口仍是唯一滚动容器（实测 body 用 `hidden` 时滚动会转移到 `body.scrollTop`、`window.scrollY` 恒为 0，影响地址栏/滚动恢复）；
  两者都禁止整页横向滚动，`overscroll-behavior-y: none` 关掉移动端下拉回弹露白。
- **宽内容在自身容器内滚动**：`.markdown-body table`（`display:block; width:max-content; max-width:100%; overflow-x:auto`，
  单元格 `min-width:6em` 保证窄屏每列可读，避免 12 列表格被压成每列 40px）、`.markdown-body pre`、`.katex-display`。
- **媒体元素**：`img/video/iframe/canvas { max-width:100%; height:auto }`；`.markdown-body { overflow-wrap:anywhere }`
  （长 URL / 无空格长串可任意断行）。
- **底部 Tab 多按钮**：按钮 `flex: 1 0 auto; min-width: 64px` + 容器 `overflow-x: auto` —— 插件多时横向滑动，
  而不是压缩按钮或撑破视口。
- **表单/列表**：站长「用户管理 → 新建组」工具条 `flex-wrap: wrap` + 输入可收缩（360px 下控件不再被裁到屏幕外）。

### 4. Android 原生（Capacitor，targetSdk 35 / Android 15）

`apps/web/android/app/src/main/res/values/styles.xml`（`AppTheme.NoActionBar`，即 BridgeActivity 运行时 setTheme 的主题）：

```xml
<resources xmlns:tools="http://schemas.android.com/tools">
  <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
    <!-- ...既有 windowActionBar / windowNoTitle / background... -->
    <item name="android:windowLayoutInDisplayCutoutMode" tools:targetApi="28">shortEdges</item>
    <item name="android:windowOptOutEdgeToEdgeEnforcement" tools:targetApi="35">true</item>
  </style>
</resources>
```

- `windowLayoutInDisplayCutoutMode=shortEdges`：允许窗口延伸到刘海/挖孔短边（API 28+；旧系统忽略该属性）。
- `windowOptOutEdgeToEdgeEnforcement=true`：Android 15 对 targetSdk 35 强制 edge-to-edge 时**退出强制**，
  状态栏/手势条区域仍由系统 decor 占位 → WebView 不会画到系统栏之下。`tools:targetApi` 仅用于抑制低版本 lint。
- **insets 兜底**：`apps/web/capacitor.config.ts` 的 `android.adjustMarginsForEdgeToEdge: 'auto'`（Capacitor 7.6+ 内置能力，
  **无需新增 npm 依赖**）。系统真的强制 edge-to-edge 时，Capacitor 会把 `systemBars + displayCutout` 的 insets 作为
  WebView 外边距（见 `CapacitorWebView#edgeToEdgeHandler`）；opt-out 生效时不会重复留白。若将来 targetSdk 升到 36
  （系统忽略 opt-out），把该值改成 `'force'` 即可继续由 insets 让位。
- `MainActivity.java` **无需改动**：Capacitor 在 `BridgeActivity.onCreate` 中已 `setTheme(AppTheme.NoActionBar)`，
  其 `CapacitorWebView#edgeToEdgeHandler` 会读取该主题属性并处理 insets；WebView 也不需要额外 `fitsSystemWindows`。
- 主题外观不变（仍 `Theme.AppCompat.DayNight.NoActionBar`，未改状态栏颜色/图标策略）。

### 5. 机型验证方法（无真机时的等价验证 + 真机步骤）

无真机时用 headless Edge/Chrome + CDP：`Emulation.setDeviceMetricsOverride`（视口/DPR/mobile）+
`Emulation.setSafeAreaInsetsOverride`（真实覆盖 `env(safe-area-inset-*)`，可验证 CSS 变量链路而非只看 CSS 文本）：

| 机型 | 视口 | DPR | 安全区 top/bottom |
|---|---|---|---|
| 华为 Mate 60 Pro | 360×777 | 3.5 | 36 / 24 |
| 常见 Android | 393×852 | 3 | 32 / 24 |
| 常见 Android | 412×915 | 2.625 | 32 / 24 |
| iPhone 14 | 390×844 | 3 | 47 / 34 |
| 横屏 | 777×360 | 2 | 0 / 24（右 28） |

逐页断言：`document.documentElement.scrollWidth <= clientWidth + 1`，且没有「超出视口、又不是在可滚动容器内」的元素；
同时断言 `.topbar` 计算 `padding-top == --sat`、`.bottom-tabbar` `padding-bottom == max(4px, --sab)`。
2026-11-14 实测：8 个视口 × 10 个页面/状态共 83 条断言全部通过。

真机确认步骤（Android 原生行为 CI 覆盖不到，需真机）：
1. `pnpm --filter @ikit/web build && pnpm --filter @ikit/web exec cap sync android` → Android Studio 安装 APK；
2. 竖屏：状态栏/挖孔不压顶栏，手势条不压底部 Tab；上下滚动时 sticky 顶栏正常；
3. 横屏（或旋转）：刘海侧不压中栏，抽屉从顶栏下沿开始；
4. 打开编辑器：工具栏可换行/滚动，键盘弹出后底部 Tab 不遮输入框；
5. 打开含宽表格 / 长代码 / 长 URL / 公式的文章：整页无横向滚动条，表格/代码块/公式在自身容器内横向滑动。

## 三端互联要点

1. **统一数据源**：核心服务是单一事实源，三端通过同一套 REST 操作数据
2. **实时同步**：WebSocket 事件桥接（`knowledge:changed` 等）让三端实时联动——任一端的变更，其他端自动刷新
3. **移动端网络**：手机需与后端在同一局域网，或用部署到公网的服务器地址；`capacitor.config.ts` 已开启明文 http（生产建议 https）
4. **后续可扩展**：机器人适配器插件接入后，机器人端也复用同一套服务，实现「机器人 + Web + 桌面 + 移动」全端一致

## 常见问题

**桌面/移动端连不上后端？**
- 确认后端 `HOST=0.0.0.0`（默认已设置），监听所有网卡
- 确认 `VITE_API_BASE` 指向的地址可从该端访问（移动端用局域网 IP，不是 localhost）
- 检查防火墙是否放行 3000 端口

**移动端 WebSocket 连不上？**
- `wsUrl()` 会自动把 `http://` 转成 `ws://`，确认后端 WS 端点 `/ws` 可访问

**生产部署？**
- 后端加 `@fastify/static` 托管 `apps/web/dist`，Web 端即可同源部署（`VITE_API_BASE` 留空）
