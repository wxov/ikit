# 插件签名与密钥管理（ed25519 · 完善⑥）

> 面向**发布者/运维（站主）**的操作手册。方案与验收标准见 `docs/ai-delivery/完善⑥-插件签名体系-方案.md`。
> 目标：把插件包的信任根从「`registry.json` 托管方可信」提升到「持有官方私钥者可签」，与既有的
> 「内容哈希（防传输篡改）」形成两级防线。**零新依赖**：仅 Node 内置 `node:crypto` + 已有 `adm-zip`。

---

## 1. 机制一句话

```
签名对象 = 文件树规范序哈希 sha256OfFileTree(解压后条目)   ← 与服务器安装时的 sha256 完全同源（语义冻结）
被签字节 = 该哈希的 64 位小写 hex 字符串（UTF-8，64 字节）
签名算法 = ed25519（base64url，86 字符）
keyId    = 'ikit-' + sha256(公钥 SPKI DER)[:16]           ← 由公钥派生，不可人为指定
载体     = zip archive comment（前缀 ikit-plugin-signature: + 单行 JSON）
           / registry.json 条目平铺字段 signature,keyId,signedHash,signedAt
           / API 请求体同名字段（优先级最高）
验签时机 = installFilesAtomically 落盘之前（远端安装、本地导入同一把关点）
```

- **为什么用 zip archive comment**：comment 不是 zip 条目，因此 `sha256OfFileTree` 与既有校验链
  **零语义漂移**（导出→导入闭环还能原样带回签名）。
- **为什么被签字节是 hex 字符串**：可直接从 `registry.json`/`plugins.json` 的 `sha256` 复制粘贴复现，
  没有「先 hex 解码」的静默错位面；第三方用 `openssl pkeyutl -rawin` 亦可对拍。
- **`signedAt` 是签名方自报的信息性字段**，不参与信任判断；服务端权威时间是 `signatureVerifiedAt`。

---

## 2. 密钥生成与备份

```bash
node scripts/gen-plugin-key.mjs [--out .keys] [--force] [--name official]
```

| 产物 | 说明 |
|---|---|
| `.keys/plugin-signing.key.pem` | **私钥**（PKCS8 PEM，文件权限 `0600`，`flag:'wx'`：已存在即报错，除非 `--force`） |
| `.keys/plugin-signing.pub.pem` | 公钥（SPKI PEM；公钥是公开信息，可随配置/镜像分发） |

- stdout 只打印 **keyId / `.env` 行 / 可粘贴进 `src/trusted-keys.ts` 的片段 / gitignore 检查结果**；
  **绝不打印私钥内容**（脚本内部只落盘、不输出、不入日志）。
- **`.keys/` 已整体 gitignore**（私钥绝不入库）。脚本会执行 `git check-ignore` 自检并在未命中时醒目告警。
- **备份要求**：生成后用离线介质备份私钥（并记录备份位置与保管人）；**不要**把私钥放进 `.env`、
  截图、聊天记录或代码仓库。丢失私钥 = 无法再签新包（已发布包仍可验证，见 §6）。
- CI / 自动化：把私钥文件内容存为 CI Secret，签名时用 `--key-env <NAME>`（值支持字面 `\n`）。

---

## 3. 发布者签名流程

> ### ⚠️ 必读：远端签名包的 registry 条目**必须**携带签名字段
>
> 用 `--registry-entry` 签完包后，**必须把打印出的整段条目字段 `signature`/`keyId`/`signedHash`
> （连同 `sha256`/`signedAt`）真正粘进远端 `registry.json` 的对应条目**。签名只写进 zip 的 archive
> comment，而**商店列表页只读 `registry.json`、无法读取 zip comment**（设计使然：列表不下 100% 的包），
> 因此条目缺这几个字段时：
>
> - 列表按「**未签名**」标注（灰标，不显示签名徽标）；
> - `PLUGIN_SIGNATURE_MODE=enforce` 下该条 `installable:false`，安装请求在**下载之前**即被拒
>   （HTTP 400 `PLUGIN_SIGNATURE_REQUIRED`）——包本身已签名也没用，因为**校验发生在拿到包之前**。
>
> 一句话：**包签名 + 条目签名字段，两者缺一不可**（`--zip` 签名 → `--registry-entry` 输出 → 整段粘进
> `registry.json` → 用 `--verify` 逐条自查）。

```bash
# ① 打包并签名（推荐直接对「将要分发的那份 zip」签名，保证字节一致）
node scripts/sign-plugin.mjs --zip dist/hello-1.0.0.zip --out dist/hello-1.0.0-signed.zip \
     --key-file .keys/plugin-signing.key.pem \
     --registry-entry --name hello --title "Hello 示例插件" --version 1.0.0 \
     --package-url https://example.com/hello-1.0.0.zip

# 也可直接对包目录签名（按 exportPackageToZip 同规则遍历，树哈希与 --zip 同口径）：
node scripts/sign-plugin.mjs --dir plugins/hello --out tmp/hello-signed.zip --registry-entry --version 1.0.0
```

| 参数 | 说明 |
|---|---|
| `--dir <目录>` / `--zip <zip>` | 输入二选一（**`--zip` 推荐**：与服务器消费的字节完全一致）；两者树哈希同口径 |
| `--out <zip>` | 输出（默认 `<输入>-signed.zip`）；签名写入 zip archive comment |
| `--key-file <pem>` | 私钥文件（默认 `.keys/plugin-signing.key.pem`） |
| `--key-env <NAME>` | 从环境变量读私钥（CI Secret；值支持字面 `\n`） |
| `--registry-entry` | 打印**可直接粘贴进 `registry.json` 的条目片段**（含 `sha256/signedHash/signature/keyId/signedAt`）；**必须整段粘进 registry.json**（见上方必读） |
| `--print-hash` | 只打印树哈希（用于与服务器 `plugins.json` 的 `sha256` 对拍；`--dir`/`--zip` 同一口径） |
| `--verify <zip> --pub <pem/文件/base64>` | **独立验签（无需私钥）**：输出 `status: verified` / `invalid` / `unsigned` / `unverified`（`<zip>` 也可换成 `--dir <包目录>`，见 §4.4） |

发布检查清单：

1. `--verify` 通过（`status: verified`），且打印的 `keyId` 是**当前 active 密钥**；
2. `--print-hash` 的输出 == 要写进 `registry.json` 的 `sha256` == 条目片段的 `signedHash`；
3. **`registry.json` 条目已粘入 `signature`/`keyId`/`signedHash`**（缺任一 → `enforce` 下**下载前**即拒装、
   列表按「未签名」标注；可用 `--verify --dir <包目录> --signature … --key-id … --signed-hash …` 反查
   条目字段与包内容是否对得上）；
4. `registry.json` 条目的 `version` **必须**与包内 `plugin.json` 的 `version` 相同（否则安装被拒
   `PLUGIN_STORE_VERSION_MISMATCH`，防「旧包冒充新版本」静默降级）；
5. 分发**签名脚本产出的原始 zip**：用普通解压再压缩会丢掉 comment（签名消失 → enforce 下拒装，
   但不会伪造出「验签通过」）。

---

## 4. 客户端（实例）配置与验签

### 4.1 配置键

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `PLUGIN_SIGNATURE_MODE` | `off` \| `warn` \| `enforce` | **`warn`** | 非法值按 `warn` 处理并 warn 日志（不 crash） |
| `PLUGIN_SIGNING_PUBKEY` | PEM 单行（字面 `\n` 亦可）/ base64 SPKI | 空 | 单密钥（Docker/K8s Secret 注入友好） |
| `PLUGIN_SIGNING_PUBKEY_FILE` | 文件路径 | 空 | 单密钥（与 `gen-plugin-key.mjs` 输出天然配套） |
| `PLUGIN_SIGNING_KEYS` | JSON 映射 `{"<keyId>": "<base64 SPKI>" \| {"publicKey":…,"status":"active\|retired"}}` | 空 | 多密钥/轮换过渡 |

优先级：`PLUGIN_SIGNING_KEYS` > `PLUGIN_SIGNING_PUBKEY(_FILE)` > 内置信任表（`src/trusted-keys.ts`，默认空）。
每个信任项的 `keyId` **必须等于由该公钥派生的 keyId**；不等则启动 `warn` 并**忽略该项**（fail-closed），
避免「贴错公钥」表现为「验签莫名失败」。

### 4.2 三模式行为

| 行为 | `off` | `warn`（默认） | `enforce` |
|---|---|---|---|
| 验签执行 | 否 | 是（包/条目带签名时） | 是（必须带签名） |
| 未签名包安装（远端/导入） | 允许 | **允许** + `unsigned` + 日志 warn | **拒绝** 400 `PLUGIN_SIGNATURE_REQUIRED`（registry 条目**下载前**即拒） |
| 验签失败 | 不适用 | **允许** + `invalid`/`unknown-key` + 红标 | **拒绝** 400 `PLUGIN_SIGNATURE_INVALID` / `_KEY_UNKNOWN` / `_MALFORMED` |
| 落库签名字段 | 不写 | 写 | 写 |
| 商店 `installable/blockedReason` | 不受影响 | 不受影响（仅徽标） | 未签名/密钥未知/验签失败 → `installable:false` + 原因；前端按钮禁用 |
| catalog 7 条 / builtin `agent` | — | — | **不入链路**（`signatureStatus === undefined`，不误伤） |
| 已装包（含 warn 期装的未签名包） | — | — | **保持已装**、可启停/卸载，仅**新装与更新**被拦 |

### 4.3 验签顺序（严格串行，全部在落盘前）

```
名称比对 → 版本比对(F2) → sha256 比对 → 信封格式 → keyId 查信任表 → signedHash 一致 → crypto.verify → 落盘
```

- `enforce` 失败时**磁盘零副作用**（无 staging、无目标目录、`plugins.json` 无变更）。
- 日志每行 `[plugin-registry][signature] install "<name>" mode=<m> source=<s> status=<st> keyId=<k|-> hash=<前 8 位>…`；
  **任何分支都不输出密钥内容**。
- `store()` / `list()` / 启动**不做**任何哈希或加密运算（只查 keyId 表）；已装包**不在列表/启动时重验**
  （`signatureStatus` 是安装时的历史结论，`signatureVerifiedAt` 说明时效）。

### 4.4 独立复核（任何第三方都可做）

```bash
# zip 输入（签名载体 = zip archive comment）
node scripts/sign-plugin.mjs --verify <zip> --pub <公钥 PEM 或 base64 SPKI>          # verified / invalid / unsigned
node scripts/sign-plugin.mjs --verify --zip <zip> --pub <公钥 PEM 或 base64 SPKI>    # 等价写法（显式 --zip）
node scripts/sign-plugin.mjs --zip <zip> --print-hash                               # 复算树哈希，与 plugins.json 对拍
node scripts/sign-plugin.mjs --dir <包目录> --print-hash                            # 目录同一口径

# 目录输入（目录没有 comment 载体 → 信封从参数读，通常直接粘 registry.json 条目字段）
node scripts/sign-plugin.mjs --verify --dir <包目录> --pub <公钥> \
     --signature <86 字符 base64url> --key-id <ikit-…> --signed-hash <64 位 hex>
```

三种写法共用同一段结论输出（`zip:`/`dir:` → `treeSha256:` → `keyId:`/`signedHash:` → `status:` → `error:`），
`--verify --dir` 与 `--verify --zip` 的 **status 文案与退出码完全一致**：

| `status` | 含义 | 退出码 |
|---|---|---|
| `verified` | 提供 `--pub` 且 `keyId` 派生一致 + `signedHash` 与内容一致 + `crypto.verify` 通过 | **0** |
| `unsigned` | 无签名信封（zip comment 无 `ikit-plugin-signature:` 前缀；目录未给签名字段参数） | **0** |
| `unverified` | 解析出信封但未提供 `--pub`（无法判断信任） | **0** |
| `invalid` | 信封字段非法（schema/alg/keyId/signedHash/signature 形态，或 comment > 4096 字节）/ 公钥派生 keyId 与信封不符 / `signedHash` 与内容不符 / `crypto.verify` 失败 | **1** |
| （无 `status` 行） | 用法或文件错误（缺参数、`--dir` 与 `--zip` 同时给、目标或私钥/公钥文件不存在或不可解析） | **2** |

> CI 断言建议：**必须已签名且可信** → 断言 `status: verified`（不要只依赖退出码，因为 `unsigned` 与
> `verified` 同为 exit 0，与服务器「warn 模式放行未签名包」的语义保持一致）；**必须不是坏包** → 断言
> 退出码 `≠ 1`。`invalid`(1) 与用法错误(2) 分开，便于区分「包有问题」和「命令/环境有问题」。
> 退出码 2 与 comment/字段级原因是**完善⑥ 修复批次**补充的，`status:` 行文案与状态集合未变。
>
> 工具链回归自检：`node scripts/sign-plugin-smoke.mjs`（62 项，覆盖 `--dir` 四条路径与 `--zip` 全流程；
> 产物只写系统临时目录、结束即删，**不在仓库内生成 `.keys/`**）。

---

## 5. 状态含义与前端展示

| `signatureStatus` | 含义 | 徽标 |
|---|---|---|
| `verified` | 验签通过（含 `retired` 密钥，附轮换提示） | 🔒 已签名·验证通过（绿） |
| `unverified` | 已声明签名、本机尚未验证（未安装的远端条目 / 未配置公钥） | 🔏 已签名·装机时验证（蓝灰） |
| `unsigned` | 无签名（无法确认来源） | 未签名（灰） |
| `invalid` | 信封非法 / `signedHash` 与内容不一致 / `crypto.verify` 失败 | ⚠️ 验签失败（红，含 `signatureError`） |
| `unknown-key` | `keyId` 不在信任表（含已吊销） | ⚠️ 签名密钥未受信任（红） |
| `undefined` | 不适用（catalog/builtin）或旧记录未评估 | 不显示徽标 |

**空信任表豁免**：未配置任何公钥时，「有签名但无表可查」记 `unverified`（而不是满屏 `unknown-key`），
并在启动日志 warn「未配置任何签名公钥」；信任表非空时未知 keyId 一律 `unknown-key`（真实信号，不掩盖）。

---

## 6. 轮换与吊销

| 场景 | 动作 | 结果 |
|---|---|---|
| **轮换（加新密钥）** | ① 生成新密钥（新 keyId）；② 把新公钥**追加**进信任表（内置常量随版本发布，或该实例的 `PLUGIN_SIGNING_KEYS`）；③ 新包用新密钥签；④ 旧 keyId 置 `status:'retired'` **保留**在表中 | 旧包**仍验签通过**，附 `signatureWarning: 签名密钥已轮换（retired）`；完成迁移后可删除旧项 |
| **吊销（私钥泄露）** | 从信任表**删除**该 `keyId` | 其签名一律 `unknown-key`；`enforce` 下这些包无法**新装/更新**（已装的不受影响）；随后**用新密钥重签已发布包** |
| **私钥丢失** | 生成新密钥并加入信任表；旧 keyId 保留 `retired` 以维持旧包可安装 | 无法再签新版本；已发布包仍可验证 |

> 官方首个密钥生成后，把 `gen-plugin-key.mjs` 打印的片段写进
> `packages/plugins/plugin-registry/src/trusted-keys.ts` 的 `BUILTIN_TRUSTED_KEYS`，
> 用户零配置即可验证官方包（内置表默认空 = fail-closed，不臆造密钥）。

---

## 7. 何时可切 `enforce`（判据）

1. 官方 `registry.json` 中 **100%** 条目都带 `signature/keyId/signedHash`（逐条 `--verify` 自查）；
2. 官方公钥已进入**内置常量**（用户零配置可验），且已运行 `warn` **至少 1 个 release 周期**；
3. 生产日志中 `[plugin-registry][signature] … status=unsigned|invalid|unknown-key` **连续 30 天为 0**
   （或剩余命中均已被管理员确认为自建本地包）；
4. 运维文档已发布（本文）且密钥备份位置、丢失预案已登记；
5. 自建/本地导入场景的管理员已知悉：`enforce` 后未签名包无法导入，需先自签或配置其公钥。

切换动作本身只是**环境变量变更**（`PLUGIN_SIGNATURE_MODE=enforce`，无需发版）；把代码**默认值**改成
`enforce` 属于后续版本决策，必须在判据 1–5 全绿后做，并在版本说明中公告。

---

## 8. 回滚（一分钟）

| 层级 | 动作 | 效果 |
|---|---|---|
| 配置级（秒级、无需发版） | `PLUGIN_SIGNATURE_MODE=off` + 重启 | 不验签、不写签名字段、无徽标 —— 完全等价于本功能上线前；`plugins.json` 里的旧签名字段被忽略 |
| 降级级 | `PLUGIN_SIGNATURE_MODE=warn` | 恢复「只提示不拒装」 |
| 代码级 | `git revert <⑥ 的提交>` | 回到 ⑤ 之后状态；数据层只有可选键，**无需数据回滚脚本、无停机窗口** |
| 密钥级 | 见 §6 | 不影响已发布包的可验证性（除被吊销密钥的包） |

---

## 9. 常见错误码

| 码（HTTP 400） | 触发 | 处置 |
|---|---|---|
| `PLUGIN_SIGNATURE_REQUIRED` | `enforce` 下无签名 | 用签名脚本重新发包，或改用已受信任密钥签名；自建包可临时 `MODE=warn` |
| `PLUGIN_SIGNATURE_MALFORMED` | 信封字段缺失/格式非法（`signature` 非 86 字符 base64url、`signedHash` 非 64 位 hex、`alg ≠ ed25519`、`schema ≠ 1`、comment JSON 非法） | 重新签名；确认 zip comment 未被工具改动 |
| `PLUGIN_SIGNATURE_KEY_UNKNOWN` | `keyId` 不在信任表（或已吊销） | 把发布方公钥加入信任表（`PLUGIN_SIGNING_KEYS`/`_PUBKEY(_FILE)` 或内置常量） |
| `PLUGIN_SIGNATURE_INVALID` | `signedHash` 与内容不一致 / `crypto.verify` 失败 | 包内容被改动或签名与包不匹配 → 重新获取原始签名包 |
| `PLUGIN_STORE_VERSION_MISMATCH` | registry 声明版本 ≠ 包内 `plugin.json` 版本 | 修正 `registry.json` 条目（防静默降级） |

---

## 10. 私钥泄露应急预案（R1）

1. **立即吊销**：从信任表删除泄露的 `keyId`（内置常量走发版；实例走 `PLUGIN_SIGNING_KEYS` 变更 + 重启）。
2. **重签**：生成新密钥 → 加入信任表（`active`）→ 用新密钥重签所有已发布包 → 更新 `registry.json`
   （`signature/keyId/signedHash` 同步替换）。
3. **通告**：在发布说明中公告吊销时间窗与新 keyId；提醒用户升级到新签名包。
4. **复盘**：确认泄露渠道（`.env`/截图/CI 日志/仓库），并把私钥仅保留在 `.keys/` + 离线备份 + CI Secret。
5. 以上全程不影响「已装包」的可用性，也不阻塞 `warn` 模式下的既有流程。
