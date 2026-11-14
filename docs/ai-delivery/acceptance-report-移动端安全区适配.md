# 验收报告 · 移动端安全区与横向溢出适配

> **角色**：测试验收工程师（独立验收；**未改任何源码、未执行任何 git 命令**）
> **验收对象**：`develop` 工作区未提交改动（任务说明为 9 个文件；本次只读核对，未用 git 命令）
> **验收时间**：2026-11-14 ｜ **环境**：Windows / Node v24.15.0 / pnpm 10.33.2 / Edge 157.0.4341.46（headless）
> **隔离声明**：临时实例 `%TEMP%\ikit-accept-983f353d`（`PORT=3211`，独立 `cwd` / `data` / `plugins` / 日志），前端用 `apps/web/dist` 由该实例同源托管；测试文章/回收站数据仅写入临时 `data`。**未写入**真实 `packages/server/data`（验收前后 mtime 不变）与 `plugins/`；临时实例未注入仓库 `.env`（用显式 env 覆盖）。构建与 Android 验证会重写 `apps/web/dist`、`apps/web/android/app/src/main/assets/**`、`android/**/build/**` 等**构建产物**，未改源码；**未复用开发者脚本与自报数据**。
> **结论**：**PASS**（Web/构建/静态证据充分；Android 原生系统栏行为列入真机待确认，见 §7）。
> **必须修：0**；**建议修：3**（P2×1、P3×2）；**可忽略：4**。

---

## 1. 范围与方法

用户报障三项：① 顶部与状态栏/信息栏重叠；② 底部与手势条/导航栏重叠；③ 内容超宽出现横向滚动条。

本报告独立完成：

1. 全量构建 / typecheck / `cap sync android`；
2. 逐文件静态实证（CSS 语义、Android 资源、Capacitor 原生链路、文档一致性）；
3. 自建 CDP harness（**非**开发者脚本）：临时实例 + API 播种内容 + Edge headless + `Emulation.setDeviceMetricsOverride` + `Emulation.setSafeAreaInsetsOverride`，覆盖 8 个视口、每个 8～11 个页面/状态，共 **81 个页面/状态、1201 条断言**；
4. 补充探针：安全区动态联动、`overflow-x: clip` 滚动容器语义、桌面三档布局、顶栏子元素宽度、Android APK 打包检查。

---

## 2. 构建与类型检查

| 命令 | 结果 |
|---|---|
| `pnpm -r --if-present build` | **exit 0**（10 个 build 脚本 + web prebuild 全部 `Done`；`apps/web: vue-tsc --noEmit && vite build` → `✓ built in 2.54s`；仅 chunk >500kB 警告） |
| `pnpm --filter @ikit/web typecheck` | **exit 0** |
| `pnpm --filter @ikit/web exec cap sync android` | **exit 0**；生成 `android/app/src/main/assets/capacitor.config.json` 含 `"adjustMarginsForEdgeToEdge": "auto"`（实测读取确认） |
| `aapt2 compile --dir android/app/src/main/res` | **exit 0**（aapt2 2.19 / build-tools 34.0.0，输出 210,958 B） |
| `gradlew :app:processDebugResources`（JDK 21 / Gradle 8.11.1 / compileSdk 35，`--offline`） | **BUILD SUCCESSFUL in 40s**（31 tasks；证明 styles.xml 语法、主题父级与两个 android 属性在 compileSdk 35 下可链接） |
| `gradlew :app:assembleDebug`（联网） | **BUILD SUCCESSFUL in 34s**（65 tasks；APK 6,897,885 B）。首次 `--offline` 因 Gradle 缓存缺 `org.jetbrains:annotations:13.0` 失败，联网补缓存后成功——**环境缓存问题，非代码问题** |

---

## 3. 静态实证

### 3.1 viewport

`apps/web/index.html:5-7`：

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

运行期从页面读取 `meta[name=viewport].content` 含 `viewport-fit=cover`（81/81 状态）。未设置 `maximum-scale` / `user-scalable=no`，可访问性保留。

### 3.2 安全区变量与使用点

`apps/web/src/style.css:13-20`：

```css
--sat: env(safe-area-inset-top, 0px);
--sab: env(safe-area-inset-bottom, 0px);
--sal: env(safe-area-inset-left, 0px);
--sar: env(safe-area-inset-right, 0px);
```

全仓库 `apps/web/src` 内 `env(safe-area-inset-*)` 仅这 4 处（变量定义），其余全部经变量消费——链路唯一、无旁路。

| 位置 | 规则（源码） | 语义核对 | 实测（Mate60 / iPhone14） |
|---|---|---|---|
| `.topbar` | `padding: var(--sat) max(24px,var(--sar)) 0 max(24px,var(--sal)); height: calc(60px + var(--sat))`（`style.css:118-129`） | 顶部整体下移，60px 内容基线不变；左右横屏刘海 | pt 36/47；height 96/107 ✓ |
| ≤768 顶栏 | `padding: var(--sat) max(12px,var(--sar)) 0 max(12px,var(--sal))`（`App.vue:1415-1418`） | 与全局高度协同，未重复加高 | 360：pt 36、h 96 ✓ |
| 抽屉 `.portal-left/right` | `top: calc(60px + var(--sat)); padding-bottom: max(12px,var(--sab)); 左右 max(10px,insets)`（`App.vue:1389-1404`） | 从顶栏下沿开始，不钻状态栏/手势条 | top 96/107；pb 24/34 ✓ |
| `.bottom-tabbar` | `height:auto; min-height:56px; padding-bottom: max(4px,var(--sab)); 左右 var(--sal/sar); overflow-x:auto`（`App.vue:1422-1439`） | 手势条由 padding 让开；按钮不压缩 | h 63/73；pb 24/34 ✓ |
| `.portal-main, main` | `padding-bottom: calc(72px + var(--sab))`（`App.vue:1471-1473`） | 末段内容不被固定 Tab/手势条盖住 | 96/106 ✓ |
| `.mobile-admin-sheet` | `bottom: calc(64px + var(--sab)); left/right max(8px,insets)`（`App.vue:1474-1488`） | 浮层在 Tab 之上 | bottom 88/98 ✓ |
| `.portal`（≤768） | `padding: 12px max(12px,var(--sar)) 12px max(12px,var(--sal))`（`App.vue:1463-1466`） | 横屏刘海 | 360/390：12px；见 §6-S2（>768 时该规则不生效） |
| `#app` / `.app` | `min-height:100vh; 100dvh`（`style.css:105-115`） | 地址栏收放不跳动 | 计算值正常 |

补充：`.side-backdrop` 顶部同样用 `calc(60px + var(--sat))`（`App.vue:1180`），遮罩不压状态栏。

### 3.3 横向溢出治理

- `html { height:100%; overflow-x:hidden; overscroll-behavior-y:none }`、`body { height:100%; overflow-x:clip; overscroll-behavior-y:none }`（`style.css:52-68`）。运行时计算值 81/81 状态均为 `html=hidden`、`body=clip`。
- 媒体元素 `img/video/iframe/canvas { max-width:100%; height:auto }`（`style.css:76-83`）。
- `.markdown-body { overflow-wrap:anywhere }`（`style.css:372-379`）。
- `.markdown-body pre { max-width:100%; overflow-x:auto }`（`style.css:476-484`）。
- `.markdown-body table { display:block; width:max-content; max-width:100%; overflow-x:auto }` + 单元格 `min-width:6em`（`style.css:503-523`）。
- `.katex-display { overflow-x:auto; max-width:100% }`（`style.css:535-541`）。
- `.ws { white-space:nowrap }`（`style.css:159-167`）。
- `UserManager.vue:312-314`：`.um-group-toolbar{flex-wrap:wrap}` + `.um-input{flex:1 1 140px;min-width:0}`。

### 3.4 Android 原生链路

`apps/web/android/app/src/main/res/values/styles.xml:12-28`（`AppTheme.NoActionBar`，即运行期主题）：

```xml
<item name="android:windowLayoutInDisplayCutoutMode" tools:targetApi="28">shortEdges</item>
<item name="android:windowOptOutEdgeToEdgeEnforcement" tools:targetApi="35">true</item>
```

- **语法/链接**：aapt2 compile exit 0；Gradle `processDebugResources` BUILD SUCCESSFUL（compileSdk 35）。
- **打包结果**（`app-debug.apk`，`aapt2 dump`）：
  - `targetSdkVersion:'35'`，`compileSdkVersion='35'`，versionName 0.2.8；
  - `style/AppTheme.NoActionBar` 条目：`0x01010586=1`（对 android-35 解析为 `attr/windowLayoutInDisplayCutoutMode`，值 1 = `shortEdges`）、`0x0101069a=true`（`attr/windowOptOutEdgeToEdgeEnforcement`）；
  - APK 内 `assets/capacitor.config.json` 含 `"adjustMarginsForEdgeToEdge": "auto"`（与 `cap sync` 产物一致）。
  - APK 内 Web 资源同步为修复后版本：`assets/public/index.html` 含 `viewport-fit=cover`；`assets/public/assets/index-*.css` 含 `--sat` / `safe-area-inset`（解包 APK 实测）。
- **MainActivity 是否无需改**：Capacitor 7.6.8 源码证据——`BridgeActivity.java:21-28` 在 `onCreate` 中 `setTheme(R.style.AppTheme_NoActionBar)` 后 `setContentView`；`Bridge.java:1615-1617` 创建 Bridge 时调用 `capacitorWebView.edgeToEdgeHandler(bridge)`；`CapacitorWebView.java:58-88` 读取 `adjustMarginsForEdgeToEdge`，`auto` 时在 API≥35 解析主题 `windowOptOutEdgeToEdgeEnforcement`，未 opt-out 才把 `systemBars | displayCutout` insets 设为 WebView 外边距；`CapConfig.java:291` 从 `android.adjustMarginsForEdgeToEdge` 读取（默认 `disable`）。`MainActivity.java:5-11` 仅注册热更新插件，无窗口/insets 逻辑 → **静态结论：无需改**。
- **保留意见（真机项）**：`BridgeActivity` 是 `super.onCreate()` **之后**才 `setTheme`（第 23 行 vs 25-26 行），虽在 `setContentView` 之前、且为 Capacitor 官方路径，但 opt-out 属性是否被 Android 15 在窗口生成时采纳，必须真机确认（§7）。本环境无真机/模拟器（`adb devices` 为空，SDK 无 emulator/system-images）。

### 3.5 文档一致性

| 文档 | 结论 |
|---|---|
| `docs/desktop-mobile.md:117-218` 安全区小节 | 总体一致：viewport、4 个变量、topbar/抽屉/Tab/内容底部/管理浮层、`overflow-x` 策略、媒体元素、表格/代码/公式、Android 两属性、Capacitor insets、MainActivity 说明；差异见本表末行；机型表/断言数为开发者自报（未采信） |
| `docs/需求功能总览.md:207`（模块②）、`365-372`（模块⑦） | 基本一致；模块⑦「Android 原生需真机确认」表述诚实 |
| `README.md:208`、`235-238` | 基本一致；`<768px` 与代码 `max-width:768`（含 768）有一处边界措辞差 |
| 差异点 | ① `desktop-mobile.md:153` 中栏 `.portal` 的 insets 规则**只在 ≤768 生效**，但表格/README 未限定宽度；777 视口实测走固定 24px（见 §6-S2）。② `desktop-mobile.md:150`「Tab 内容仍在 56px 基准线上」措辞不精确（`min-height:56` 为含 padding 的盒子高度；实测 63/73px，内容区约 38px）。③ `capacitor.config.ts:15-18` 注释把 `auto` 描述为「系统强制 edge-to-edge 时」兜底；实现实际是读**应用主题属性**，当前主题恒为 true，故 targetSdk 36 时 `auto` 不会兜底（文档已提示改 `force`）。 |

---

## 4. 设备模拟（独立复现）

### 4.1 方法

- 临时实例：`%TEMP%\ikit-accept-983f353d`，`PORT=3211`，`KB_STORAGE=json`，`PLUGIN_DIR=<temp>\plugins`，`WEB_DIST=apps/web/dist`；`GET /api/health` 返回 `{"ok":true}`。
- 独立播种（仅临时 data）：4 篇文章（1 篇含 12 列表格、320 字符单行代码、300+ 字符无空格 URL、长 KaTeX 行间公式；1 篇进回收站）；管理员 `admin`（临时实例 env 指定）。
- CDP：自建 Node 24 WebSocket 客户端，连接 `http://127.0.0.1:9333`；先 `Emulation.setDeviceMetricsOverride`（width/height/DPR/mobile），再 `Emulation.setSafeAreaInsetsOverride`（协议 schema `SafeAreaInsets{top,left,bottom,right,...}`，实测生效）；管理员态用 `localStorage['ikit-token']` 注入，游客态移除令牌后重载。
- 页面/状态：首页、文章详情（管理员=就地 Vditor 编辑器；游客=只读 `.markdown-body`）、新建文章编辑器、插件商店、回收站、用户管理、设置浮层、左抽屉、右抽屉、移动端站管浮层。
- 每状态断言：`document.documentElement.scrollWidth <= window.innerWidth + 1`、`body.scrollWidth` 同口径、topbar `padding-top`/`height`、tabbar `padding-bottom`/可见性、`portal-main` 底部 padding、抽屉 `top`/`padding`、站管浮层 `bottom`、`html/body` overflow 计算值、viewport meta、宽内容自身滚动、以及「非滚动容器内元素不得超出视口」扫描。

> **方法学注意**：由于 `html{overflow-x:hidden}`，`documentElement.scrollWidth` 会被“夹”在视口宽（注入 2000px 宽元素后仍报 360，而 `body.scrollWidth=2000`）。因此本报告**不单靠**页面 scrollWidth，另做逐元素扫描 + 内部滚动容器实测，避免“内容被裁剪但指标通过”的假阳性。

### 4.2 覆盖矩阵与横向溢出结果

| # | 机型/档位 | 视口 | DPR | 安全区 top/bottom（+右） | 页面/状态数 | `max(doc.scrollWidth)` / `innerWidth` | 超宽 |
|---|---|---|---|---|---|---|---|
| 1 | 华为 Mate 60 Pro | 360×777 | 3.5 | 36 / 24 | 11（含游客阅读） | 360 / 360 | **0** |
| 2 | 常见 Android | 393×852 | 3 | 32 / 24 | 11（含游客阅读） | 393 / 393 | **0** |
| 3 | 常见 Android | 412×915 | 2.625 | 32 / 24 | 10 | 412 / 412 | **0** |
| 4 | iPhone 14 | 390×844 | 3 | 47 / 34 | 11（含游客阅读） | 390 / 390 | **0** |
| 5 | 横屏 | 777×360 | 2 | 0 / 24 / 右 28 | 10（含游客阅读） | 777 / 777 | **0** |
| 6 | 桌面 | 1440×900 | 1 | 0 / 0 | 8 | 1440 / 1440 | **0** |
| 7 | 桌面 | 1000×800 | 1 | 0 / 0 | 10 | 1000 / 1000 | **0** |
| 8 | 桌面 | 700×900 | 1 | 0 / 0 | 10 | 700 / 700 | **0** |

- **总计 81 个页面/状态、1201 条断言（含 4 条动态联动），全部通过，0 失败。**
- 覆盖面含：首页、文章（管理员/游客）、编辑器、商店、回收站、用户、设置、左右抽屉；≤768 另含站管浮层。桌面 1440 无抽屉/站管浮层（不适用）。
- 断言脚本首轮有 19 条“失败”来自**断言口径**（空编辑器本无表格；777/1440 下公式本就无需内部滚动），修正口径后 0 失败；**不是产品缺陷**，已如实披露。

### 4.3 安全区计算样式（实测）

| 视口 | topbar pt / height | tabbar pb / height | portal-main pb | 抽屉 top / pb | 站管浮层 bottom |
|---|---|---|---|---|---|
| 360×777（36/24） | 36px / 96px | 24px / 63px | 96px | 96px / 24px | 88px |
| 393×852（32/24） | 32px / 92px | 24px / 63px | 96px | 92px / 24px | 88px |
| 412×915（32/24） | 32px / 92px | 24px / 63px | 96px | 92px / 24px | 88px |
| 390×844（47/34） | 47px / 107px | 34px / 73px | 106px | 107px / 34px | 98px |
| 777×360（0/24，右 28） | 0px / 60px，右 padding 28px | 不显示（桌面底栏 52px） | 18px（桌面基准） | 60px / 24px，右 28px | 不适用 |
| 1440 / 1000 | 0px / 60px | 不显示 | 18px | 1000：60px / 12px | 1000 不显示 |
| 700（0/0） | 0px / 60px | 4px / 56px | 72px | 60px / 12px | 64px |

### 4.4 安全区**动态联动**证明（非仅 CSS 文本）

Mate60 视口，**不重载**仅改 `Emulation.setSafeAreaInsetsOverride`：

| 阶段 | `--sat` / `--sab` | topbar `padding-top` | tabbar `padding-bottom` | portal-main `padding-bottom` |
|---|---|---|---|---|
| 36 / 24 | 36px / 24px | 36px | 24px | 96px |
| 0 / 0 | 0px / 0px | **0px** | **4px** | **72px** |
| 恢复 36 / 24 | 36px / 24px | **36px** | **24px** | **96px** |

→ `env(safe-area-inset-*)` → CSS 变量 → 布局的计算链路真实生效（4/4 断言通过）。

### 4.5 宽内容：只在自己容器内滚动

只读阅读端（`.markdown-body`，360 视口）：

| 内容 | clientWidth / scrollWidth | overflow-x | 页面是否超宽 |
|---|---|---|---|
| 12 列表格 | 290 / **1081** | auto | 否（360/360） |
| 320 字符单行代码 `<pre>` | 290 / **2079** | auto | 否 |
| 长 KaTeX 行间公式 | 290 / **603** | auto | 否 |
| 300+ 字符无空格 URL | 随段落 `overflow-wrap:anywhere` 断行 | — | 否 |

管理员就地编辑器（360 视口）：表格 266 / **1175**（自滚动）；公式 266 / **649**（自滚动）；长代码块在 Vditor 中 `pre-wrap` 换行（不裁剪、不撑页）。777 横屏：表格 683 / 1081、代码 683 / 2079、公式 683（恰好放下，overflow 仍为 auto）。1440：表格 708 / 1081、代码 708 / 2079。

### 4.6 桌面回归

| 档位 | `.portal` grid | 侧栏开关 | 底部 | 页面超宽 |
|---|---|---|---|---|
| 1440×900 | `280px 754px 300px`（三栏） | 隐藏（width 0） | 桌面底栏 52px | 0 |
| 1000×800 | 单栏 `942px` | 显示 | 桌面底栏 52px | 0 |
| 700×900 | 单栏 `666px` | 显示 | 移动 Tab（56px） | 0 |

700 桌面档顶栏 nav 隐藏、底栏切换为移动 Tab，符合 `max-width:768` 预期；无横向溢出。

### 4.7 `overflow-x: clip` 的滚动容器语义（验证开发者关于 `hidden` 的说法）

360 视口、长文章页：

- `document.scrollingElement === HTML`；
- `window.scrollTo(0,600)` 后 `window.scrollY=600`、`document.documentElement.scrollTop=600`、**`body.scrollTop=0`**；
- 滚动后 sticky `.topbar` 的 `getBoundingClientRect().top = 0`（粘性正常）；
- 向 `body` 注入 2000px 宽元素：`doc.scrollWidth` 仍 360、`body.scrollWidth=2000` → `body` 未成为滚动容器，整页横向被 `html` 兜底裁剪。

### 4.8 其他实测

- 设置面板（360）：320×265，位于 (20,256)-(340,521)，在视口内且高于状态栏安全区。
- 左抽屉（360）：top 96、padding-bottom 24、宽 302；右抽屉横屏右 padding 28。
- 顶栏 360 子元素宽度：侧栏开关 76 + 品牌 66 + 搜索 24 + 设置 43 + 头像 34 + 主题 43 + 5×10 gap + 24 padding = 恰好 360（**见 §6-S1**）。
- 底部 Tab（360）：4 个按钮、`overflow-x:auto`、高 63、pb 24；当前实例功能插件较少，未触发横向滑动，但容器/按钮规则已就位。
- 逐元素扫描排除 KaTeX 的 `.katex-mathml` 无障碍副本：实测 `position:absolute`、1×1px、`overflow:hidden`，不参与视觉布局（其 MathML 子元素 rect 右缘 1030 属扫描假阳性）；除该副本外，81 个状态中没有发现「非滚动容器内可视元素越出视口」。

---

## 5. 逐项对照「开发者声称」

| # | 声称 | 独立结论 |
|---|---|---|
| 1 | `index.html` 加 `viewport-fit=cover` | **属实**（`index.html:5-7`；运行期 meta 读取 81/81） |
| 2 | `:root` 新增 4 个安全区变量 | **属实**（`style.css:13-20`；仅此 4 处 `env()`） |
| 3 | `html{height/overflow-x/overscroll}`、`body{overflow-x:clip...}` | **属实且语义正确**（§4.7 实测 window 仍唯一滚动容器） |
| 4 | `#app/.app min-height:100vh;100dvh` | **属实**（`style.css:105-115`） |
| 5 | `.topbar padding/height` | **属实**（§4.3/4.4 实测 36→0→36） |
| 6 | `img/video/iframe/canvas max-width` | **属实**（`style.css:76-83`） |
| 7 | `.markdown-body` 表格/代码/公式/长 URL 规则 | **属实**（§4.5 内部滚动实测） |
| 8 | `.ws white-space:nowrap` | **属实**（`style.css:159-167`） |
| 9 | App.vue ≤1199 抽屉 insets | **属实**（top 96/107、pb 24/34、左右 insets） |
| 10 | App.vue ≤768 顶栏/Tab/portal-main/admin-sheet/搜索 | **基本属实**；搜索 `min-width:0` 在 360 下压缩到 24px（§6-S1） |
| 11 | UserManager 工具条换行 | **属实**（312-314；users 页 360 无溢出） |
| 12 | styles.xml 两属性（API28+/API35） | **属实**（Gradle 链接 + APK dump 双证） |
| 13 | capacitor `adjustMarginsForEdgeToEdge:'auto'` | **属实**（sync 产物 + APK 内 assets 双证；实现语义见 §3.5③） |
| 14 | MainActivity 无需改 | **静态属实**（§3.4 源码链路）；opt-out 运行期效果仍需真机 |
| 15 | 文档三处更新 | **基本属实**（§3.5 三处措辞/范围差异） |
| 16 | 自报「83 条断言 0 失败」 | **未采信**：本次独立重跑 81 状态/1201 断言；开发者数据未作为本报告证据 |

---

## 6. 问题分级

### 必须修（阻断）：无

三项报障在 Web 仿真层全部消除；构建、打包、静态链路均通过。

### 建议修

**S1（P2，360px 顶栏搜索框实际不可用）**
- 实测 `360×777`：顶栏 6 个可见子项合计恰好 360px，`.global-search` 仅 **24px**（输入框 30px，左右 padding 22px + 边框，文本区约 6px）；393 为 57px、412 更宽。
- 来源：`App.vue:1468-1470` 的 `.global-search{flex:1 1 0;min-width:0}` 修复了溢出，但把搜索压缩到不可读。
- 建议：≤400px 隐藏搜索框改为 🔍 按钮（点击展开/跳转），或第二行/抽屉承载；也可收窄侧栏开关/品牌占位。`/` 与 `Ctrl+K` 仍可用，但触屏用户无法正常输入。
- 不影响本次 PASS 结论（三项报障不涉及搜索），但建议下一轮优先处理；若产品把「360px 下搜索可用」视为硬性验收项，则应升级为**必须修**。

**S2（P3，769–1199 横屏/平板：主栏未让开左右刘海）**
- 实测 `777×360`、`--sar=28px`：`.portal` 计算 padding 为固定 `16px 24px 52px`，`.portal-main` 右边界 753px，而安全边界为 749px → 主栏右缘 4px 落入刘海区（内层 20px padding 使文字未受影响，但面板背景/边框进入）。
- 根因：`App.vue:1463-1466` 的 `.portal` 左右 insets 规则只在 `max-width:768` 内；769–1199 用桌面 `padding:16px 24px 52px`（`App.vue:1271`）。
- 文档 `desktop-mobile.md:153` 与 README:208 未限定宽度，称「横屏刘海不压中栏」，与实现不符。
- 建议：把 `.portal` 的左右 `max(12px, insets)` 提升到 ≤1199（或 769–1199 单独规则），并同步文档；或在文档明确「主栏刘海适配仅 ≤768」。

**S3（P3，两个固定定位元素未加 `--sat`）**
- `.app-toast { top:72px }`（`App.vue:1133`）：Mate60 sat=36 时顶栏高 96，toast 顶部 72px 落在顶栏（0–96px）内并向下延伸，压住顶栏下沿；iPhone sat=47 时更深。toast 可读（z-index 600）但视觉压顶栏。
- `.auth-close { top:8px }`（`App.vue:1121`）：登录浮层关闭按钮位于状态栏/挖孔区（sat 36/47），触控可能被系统手势区干扰。
- 建议：分别改 `calc(72px + var(--sat))`（或顶栏下沿）与 `calc(8px + var(--sat))`。

### 可忽略

- **I1** 769–1199 桌面底栏 `.bottom-bar`（52px）未含 `--sab`：内容居中且高于手势条，原生 App 主题 opt-out 下 `env(sab)=0`；仅 iOS Safari 横屏/平板等 `env(sab)>0` 的浏览器场景背景压住 home indicator 区域（非文字）。可后续统一。
- **I2** `README.md:207` 写 `<768px` 而代码 `@media (max-width:768px)`：768 归移动；纯措辞边界，无功能影响。
- **I3** `capacitor.config.ts` 的 `auto` 在 targetSdk 36/Android 16 会因主题仍解析到 opt-out=true 而不加 margins（系统已忽略 opt-out）；`desktop-mobile.md:190` 已给出「改 force」的迁移提示，属未来项，不阻断当前 targetSdk 35。
- **I4** `desktop-mobile.md:150`「Tab 内容仍在 56px 基准线上」措辞不精确：`min-height:56` 是含 padding 的盒子高度，实测 63/73px、内容区约 38px；行为本身正确（手势条由 padding 让开）。

---

## 7. Android 真机待确认项（本环境无真机/模拟器）

本机 `adb devices` 为空、SDK 无 emulator/system-images，无法做系统栏行为验证。以下项**不计入本次 FAIL**，但必须在上线前用真机确认：

| # | 项 | 期望 | 方法 |
|---|---|---|---|
| A1 | Android 15 主题 opt-out 是否生效 | 状态栏/挖孔区由系统 decor 占位，WebView 不画到其下；顶栏内容不被遮挡 | 装 `app-debug.apk`（targetSdk 35），3 键/手势导航各看一次；`adb shell dumpsys window` 看 frame 与 insets |
| A2 | `BridgeActivity` 在 `super.onCreate` 之后 `setTheme` 是否仍让 opt-out 被窗口采纳 | 同上 | 同上；若 A1 失败，改用 `AppTheme`/manifest 层承载该属性或 `adjustMarginsForEdgeToEdge:'force'` 复测 |
| A3 | 底部手势条 | 手势条区域不压底部 Tab 内容；Tab 63/73px 级高度不挡内容 | 真机竖屏滑动 + 截图 |
| A4 | 横屏挖孔侧（shortEdges + opt-out） | 刘海不压主栏/抽屉；S2 的 4px 边缘不可见即可 | 777×360 左右各转一次 |
| A5 | 软键盘 | Vditor 编辑器聚焦时底部 Tab 不遮输入框，`100dvh` 无跳动 | 真机输入法与键盘弹起 |
| A6 | 华为「显示大小/字体缩放」 | 顶栏/底栏仍不重叠（CSS px 变化可能改变 360 基准） | 系统设置调「显示大小」后复测 |
| A7 | Android 16 / targetSdk 36 | 若升级，按文档把 `auto` 改 `force` 并复测 | 升级 SDK 后回归 |

---

## 8. 方法学限制

1. **无真机/模拟器**：Android 系统栏、刘海、手势条、键盘属系统级行为，本次仅验证“Web 计算层 + APK 打包/主题静态链路”，不能替代真机。
2. **浏览器为 Edge/Chromium 157**：华为浏览器/系统 WebView 的 `env()` 支持与渲染差异未覆盖；`Emulation.setSafeAreaInsetsOverride` 只模拟 CSS 环境变量，不模拟窗口裁剪。
3. **页面级 `scrollWidth` 被 `html{overflow-x:hidden}` 夹住**：本报告用“逐元素超出扫描 + 内部滚动容器”补强；仍无法证明所有未来页面（如未覆盖的插件面板）无裁剪。
4. 首轮断言 19 条“失败”为断言口径问题（空编辑器无表格、宽屏公式无需滚动），已修正；产品缺陷为 0。
5. `assembleDebug` 首次离线失败是 Gradle 缓存缺件，联网后成功；不影响源码结论。
6. 未做 git 状态/diff 核对（遵守“不做 git 操作”）；改动清单以任务说明与只读文件为准。

---

## 9. 结论

**PASS**。

- 三项报障在独立设备仿真中全部消除：8 个视口、81 个页面/状态、1201 条断言 0 失败；`documentElement.scrollWidth` 从未超过 `innerWidth`；宽表格/长代码/公式/长 URL 均在自身容器内滚动；安全区变量经 `setSafeAreaInsetsOverride` 36→0→36 动态联动实测。
- 构建/typecheck/cap sync/aapt2/Gradle 资源链接/APK 打包全部通过；APK 内确认 targetSdk 35、`shortEdges`、`windowOptOutEdgeToEdgeEnforcement=true`、`adjustMarginsForEdgeToEdge:auto`。
- 文档与代码总体一致，存在 3 处措辞/范围差异（§3.5）。
- **必须修 0**；建议修 3（360 搜索框压缩、769–1199 主栏刘海 insets、toast/auth-close 未加 sat）；可忽略 4。
- **Android 原生系统栏/手势条/键盘行为仍需真机按 §7 清单确认**；这是本次验收唯一不能闭环的证据缺口，已在结论中显式保留。

---

## 附录 · 复现物料（均在临时目录，未入库）

- 临时根：`%TEMP%\ikit-accept-983f353d`（`data/`、`plugins/`、`logs/`、`edge-profile/`）
- CDP 脚本：`%TEMP%\ikit-accept-983f353d\cdp-acceptance.mjs`（主矩阵）、`validate.mjs`（断言复核）、`probe.mjs`（滚动/clip、桌面、横屏）、`probe-topbar.mjs`（顶栏/portal insets）、`probe-code.mjs`（编辑器代码块）
- 结果：`cdp-results.json`（81 状态原始计算样式）、`validation.json`（1201/1201）、`probe-results.json`
- 构建日志：`%TEMP%\ikit-build-*.log`；Gradle 日志：`%TEMP%\ikit-accept-983f353d\logs\gradle*.log`
- 复跑命令（示例）：`node cdp-acceptance.mjs <临时根>` → `node validate.mjs <临时根>`
