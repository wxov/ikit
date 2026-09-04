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
