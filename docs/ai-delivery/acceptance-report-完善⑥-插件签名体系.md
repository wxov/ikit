# 验收报告 · 完善⑥ 插件签名体系（ed25519）

> **角色**：测试验收工程师（**独立验收**，未改任何代码、未做 git 写操作）
> **验收对象**：`develop` 工作区现状（`HEAD = d401630` + 未提交改动）
> **权威依据**：`docs/ai-delivery/完善⑥-插件签名体系-方案.md`（§8 共 29 条 AC；Q1–Q6 用户已采纳推荐默认；**retired 语义以方案为准**——retired 仍验签通过但附 warning，`unknown-key` = keyId 不在信任表）
> **验收时间**：2026-10-14 ｜ **环境**：Windows / Node v24.15.0 / pnpm 10.33.2；本地 `pnpm dev`(:3000) 在跑（未触碰）
> **隔离声明**：测试实例位于 `%TEMP%\ikit-ab\b1|b2\**`（独立 `cwd`/`data`/`PLUGIN_DIR`/`PORT=3501-3507`；远端目录源为进程内静态 HTTP 服务 `:3591`）。密钥生成按脚本硬性约束（`--out` 必须是**项目根内相对路径**）输出到仓库内 `tmp/qa-b6-keys{,-2}/`（`tmp/` 已被 `.gitignore` 忽略），**验收后已删除**；`.keys/` 未被创建。**未触碰**真实 `packages/server/data`、`plugins/hello`（mtime 仍为 2026-08-31）。未执行任何 git 写操作。
> **结论（第 1 轮）**：**FAIL（1 项必须修）** —— 69/70 项独立检查通过，签名语义/信任表/三种模式/导出闭环/私钥零泄漏**全部验证通过**；但 **AC-4 的文档命令 `sign-plugin.mjs --dir` 恒定崩溃**（`--zip` 路径正常），属确定性缺陷。
> **结论（第 2 轮复验，2026-10-14）**：**PASS** —— AC-4 已闭环（原失败命令**字面复跑 exit 0**），`--print-hash` 三输入一致、`--verify --dir` 三态与退出码符合文档、回归脚本 `sign-plugin-smoke.mjs` **PASS 62 / FAIL 0**、私钥零泄漏；**「必须修」清零**，仅余 1 项建议（文档强提示远端签名包的 registry 条目必须携带签名字段）。详见文末「## 第 2 轮复验」。

---

## 1. 构建（AC-27）

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm -r --if-present build` | **exit 0** | 11/12 项目全 `Done`；`apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build` → `✓ 174 modules transformed` / `✓ built in 2.46s`；无 `SignatureVerdict`/`PluginInstallResult` 类型错误 |

## 2. AC 逐条结果（29 条）

### A. 密钥与工具链

| AC | 判定 | 证据 |
|---|---|---|
| AC-1 生成密钥 | **PASS** | `node scripts/gen-plugin-key.mjs --out tmp/qa-b6-keys` exit 0；生成 `plugin-signing.key.pem`（PKCS8 `BEGIN PRIVATE KEY`）与 `.pub.pem`；stdout 含 `keyId: ikit-…`、**不含**任何私钥材料 |
| AC-2 私钥不入库 | **PASS** | `git check-ignore -q tmp/qa-b6-keys/plugin-signing.key.pem` → 命中（`tmp/` 已忽略）；`git status --porcelain` 无密钥文件；仓库内无 `.keys/` |
| AC-3 幂等/防覆盖 | **PASS** | 二次执行 → 非 0 退出「✗ 私钥已存在，拒绝覆盖」且文件哈希不变；`--force` 在另一目录验证可覆盖 |
| **AC-4 签名产物（`--dir`）** | **FAIL** | **`node scripts/sign-plugin.mjs --dir <pkg>` → exit 1**：`TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined`，栈指向 `scripts/sign-plugin.mjs:96 walk()` ← `filesFromDir()`。**根因**：`filesFromDir` 的 `for (const it of readdirSync(cur))` 缺少 `{ withFileTypes: true }`，`it` 是字符串而代码按 `it.name`/`it.isDirectory()` 使用（`path.join(cur, undefined)`）。该命令正是 **AC-4 的字面命令**，也是 `README.md:293` 与 `docs/plugin-signing.md:60` 的首选示例 |
| AC-4' 签名产物（`--zip`，方案推荐路径） | **PASS** | `--zip <zip> --out <signed> --registry-entry --key-file …` exit 0；输出 `sha256` 64 位小写 hex、`signature` 86 字符 base64url、`keyId` 与 AC-1 一致；脚本自检「读回复验 verified / 树哈希未漂移 / 条目数 2→2」；`--registry-entry` 打印含 `sha256/signedHash/signature/keyId/signedAt` 的条目片段 |

### B. 签名与哈希语义一致性（核心）

| AC | 判定 | 证据 |
|---|---|---|
| AC-5 哈希语义一致（钉死漂移） | **PASS** | `--print-hash --zip` 输出 == 签名时的 `sha256` == zip comment 内 `signedHash` == **我自写实现**的树哈希（`sorted(relPath)+"\0"+content` 的 sha256）→ 四者逐字相等（`41e8c497…`） |
| AC-6 独立验签（无私钥） | **PASS** | `--verify <signed> --pub <pub.pem>` → verified；无 comment 的包 → unsigned；「篡改内容 + 保留原 comment」→ invalid；并用自写 `node:crypto` 复核：`crypto.verify(null, Buffer.from(signedHash,'utf8'), pub, Buffer.from(signature,'base64url'))` → **true**；**反证**：若按 `hex` 解码被签名字节则 **false** → 钉死「hex 字符串 UTF-8」语义（Q1） |

### C. warn 模式（默认）

| AC | 判定 | 证据 |
|---|---|---|
| AC-7 签名包验证通过（远端） | **PASS** | registry 条目携带签名片段（`--registry-entry` 产物）→ `refresh` 200 → `install {name:"qasign6"}` **200** + `signature.status:"verified"`、`keyId` 回显；`plugins.json` 该记录 `signatureStatus=verified`、`signerKeyId`、`signature`（86 字符 base64url）、`signatureVerifiedAt` ISO |
| AC-8 签名包验证通过（本地导入） | **PASS** | `POST /import {data:<base64 signed zip>}`（**不带**请求体签名字段）→ 200 + `verified`（仅靠 zip comment） |
| AC-9 未签名包（warn） | **PASS** | 无 comment 的包 → **200** + `signatureStatus:"unsigned"`；日志 `[plugin-registry][signature] install "…" mode=warn source=local status=unsigned keyId=- hash=…`；前端「未签名」灰标 + 安装前二次确认（代码级：`PluginStore.vue:84-90,365-366`） |
| AC-10 篡改（warn，标红不拒装） | **PASS** | 保留原签名 + 内容已改 → **200** + `invalid` + `error:"验签失败：签名与内容不匹配（keyId=…，signedHash=5d6116ac… ≠ 实际 c257f653…）"`；包已落盘可启用 |
| AC-11 未知密钥（warn） | **PASS** | 请求体 `keyId:"ikit-0000000000000000"` → **200** + `unknown-key` + 文案列出当前信任表 keyId |
| AC-12 格式非法（warn） | **PASS** | 请求体 `{signature:"abc"}` → **200** + `invalid` + `malformed:true` + 字段级文案（`keyId 非法（空）`；若给 keyId 则报 `signature 非法（应为 86 字符 base64url…）`）；同一输入在 enforce 下 → **400 `PLUGIN_SIGNATURE_MALFORMED`** |
| AC-13 空信任表豁免 | **PASS** | 不设三键 + 内置表空 → 启动日志 `trustedKeys=0`；签名包 → **`unverified`**（**不是** unknown-key），附「未配置任何签名公钥，签名一律无法验证…」 |

### D. enforce 模式

| AC | 判定 | 证据 |
|---|---|---|
| AC-14 未签名拒装（远端） | **PASS** | `install {name:"qaunsign6"}` → **400 `PLUGIN_SIGNATURE_REQUIRED`**；静态源命中 **0**（**下载前拦截**）；无 `.staging-*`/`.backup-*` |
| AC-15 未签名拒装（导入） | **PASS** | `POST /import`（无签名 zip）→ 400 `PLUGIN_SIGNATURE_REQUIRED`；`plugins/qahello6` 未创建 |
| AC-16 验签失败拒装 | **PASS** | 篡改包 → 400 `PLUGIN_SIGNATURE_INVALID`；磁盘零副作用（无目录、无 staging） |
| AC-17 未知密钥拒装 | **PASS** | → 400 `PLUGIN_SIGNATURE_KEY_UNKNOWN`；文案列出当前信任的 keyId |
| AC-18 签名包正常安装 | **PASS** | 同一 enforce 实例 `install {name:"qasign6"}` → **200 + verified**；`GET /api/plugin-store` 该条 `installable !== false` |
| AC-19 列表预标注 | **PASS** | 未签名远端条目 `installable:false` + `blockedReason:"未签名：当前策略要求插件签名（PLUGIN_SIGNATURE_MODE=enforce）"`；顶层返回 `signatureMode:"enforce"` + `trustedKeyIds:[…]`；前端按钮 `:disabled="busy===p.name || blocked(p)"` + `title=blockedReason`（代码级 `PluginStore.vue:115,368,381-382`） |
| AC-20 版本一致性（F2） | **PASS** | 目录 `version 9.9.9` vs 包内 `1.0.0` → **400 `PLUGIN_STORE_VERSION_MISMATCH`**（warn/enforce 一致）；恢复后 200（同 ⑤ 报告 A-35） |

### E. 兼容与回归

| AC | 判定 | 证据 |
|---|---|---|
| AC-21 内置 7 条目录 | **PASS** | catalog 条目无签名徽标字段（`signatureStatus === undefined`）；enforce 下 `install {name:"notes"}` 仍 **200**（假安装路径不入验签链路） |
| AC-22 builtin `agent` | **PASS** | `GET /api/plugins` 中 `agent` 正常（builtin），启停/排序不受影响（⑤ 报告 A-39/A-43 排序用例含 agent） |
| AC-23 旧数据兼容 + `off` | **PASS** | `PLUGIN_SIGNATURE_MODE=off`：签名/未签名包均 **200**、`plugins.json` **不写**任何签名字段（`signatureStatus/signature/signerKeyId` 全 `undefined`）、响应无 `signature` 段、日志无 `[plugin-registry][signature]` 行 → 完全等价现状 |
| AC-24 F1 回归（loader 不自证 hash） | **PASS** | 手造 `plugins/fakehash/plugin.json`（`sha256:"000…0"`）→ 重启后 `GET /api/plugins`（admin）记录存在且 `sha256 === undefined`（未被自报值覆盖）；`index.ts:103-116` 明确注释 |
| AC-25 导出→导入闭环（enforce） | **PASS** | `GET /api/plugin-store/qahello6/export` → zip comment 保留 `ikit-plugin-signature:`；重新 `POST /import` → **200 + verified**（签名随导出保留） |
| AC-26 `off` 回落 | **PASS** | 见 AC-23（同一实测） |
| AC-28 私钥不出现在日志/响应 | **PASS** | 7 份服务日志 `grep "PRIVATE KEY"` → 0 命中；`plugins.json` / `GET /api/plugin-store` 响应无私钥材料（仅 keyId + 86 字符 base64url 签名） |
| AC-29 `store()` 无重活 | **PASS（代码级）** | `GET /api/plugin-store` 只查信任表 keyId（`signatureInfo()`）与既有字段，不做哈希/验签（`service.ts` 无在该路径调用 verify） |

## 3. 超出 AC 的独立验证

| # | 项目 | 结果 |
|---|---|---|
| E-1 | **keyId 可复算** | `ikit-` + `sha256(SPKI DER).hex[:16]` 由我用 `node:crypto` 独立算出 == 脚本/服务端输出（`ikit-719270023472bfe1`） |
| E-2 | **被签名字节语义** | 独立 `crypto.verify` 通过；hex 解码反证失败；自写 `crypto.sign` 的标准 detached 签名同样可验（无隐藏前缀/换行） |
| E-3 | **comment 往返零漂移** | 同一包「无 comment」与「有 comment」的 zip：树哈希**相同**、条目数相同（2/2）、路径集相同；comment 不产生额外条目 |
| E-4 | **信任表三键与优先级** | `PLUGIN_SIGNING_PUBKEY_FILE`（PASS）；换成 key2 → key1 签名包 `unknown-key`（作用域正确）；`PLUGIN_SIGNING_KEYS` 装载成功；**keyId 与公钥错位 → 忽略该项 + warn（trustedKeys=0，fail-closed）** |
| E-5 | **retired 语义（用户已裁定以方案为准）** | `PLUGIN_SIGNING_KEYS` 中该 keyId `status:"retired"` → **`verified`** + `warning:"签名密钥已轮换（… 状态 retired），本次签名仍有效"`；`unknown-key` 以「keyId 完全不在表」独立用例验证（AC-11/17）。方案 §13.3 记录的「上游清单曾写 retired=unknown-key」差异**按用户裁定关闭，不算缺陷** |
| E-6 | **发布运维约束（重要观察）** | 远端**签名包**的 registry 条目若**缺** `signature/keyId/signedHash` 字段 → 列表按「未签名」标注、enforce 下**下载前**即 400。这是设计使然（列表页无法读 zip comment），但意味着发布者**必须**把 `--registry-entry` 输出真正粘进 `registry.json`，否则签名包会被拒装。建议在 `docs/plugin-signing.md` 显著提示（已实测复现：条目缺字段 → `PLUGIN_SIGNATURE_REQUIRED`） |
| E-7 | 运行期私钥零泄漏 | 全部实例日志、`plugins.json`、API 响应无 `PRIVATE KEY`；`git status` 无密钥文件（`tmp/` 忽略） |

## 4. 必须修 / 建议修 / 可忽略

**必须修（1）**
1. **`scripts/sign-plugin.mjs` 的 `--dir` 模式恒定崩溃（AC-4 未达成）** —— 证据：`node scripts/sign-plugin.mjs --dir <任意目录>` → `exit 1` + `TypeError [ERR_INVALID_ARG_TYPE] … Received undefined`，栈 `sign-plugin.mjs:96 walk()` ← `:108 filesFromDir()`。**一行修复**：`for (const it of readdirSync(cur, { withFileTypes: true }))`（或改用 `{name, isDirectory}` 形式）；修好后建议补一条 `--dir` 冒烟用例（当前开发者冒烟只跑 `--zip`，故未发现）。同时 `--print-hash --dir` 同样受影响。

**建议修（2）**
2. `docs/plugin-signing.md` / `README.md` 的「插件签名快速上手」当前把 `--dir` 作为首选示例（`README.md:293`）——修复前建议把示例改成 `--zip`（与服务器消费字节一致的推荐路径），或先修 bug 再保留示例。
3. 在签名运维手册中加一句 E-6 的强提示：**远端签名包的 registry 条目必须携带签名字段**，否则 enforce 下会被下载前拒装。

**可忽略（3）**
4. `--dir` 与 `--zip` 两条路径的树哈希一致（都按 `sorted(relPath)+"\0"+content`），故 `--dir` 修复后不会引入哈希语义漂移。
5. `gen-plugin-key.mjs` 不打印私钥的 base64 单行形式（方案 §4.1.1 曾提「便于 CI Secret」）→ 按上游「绝不输出私钥」硬性要求执行，属**可接受偏差**（脚本已改为提示用 `--key-env`）。
6. 运维文档文件名用 `docs/plugin-signing.md`（方案 §5 写 `docs/插件签名与密钥管理.md`）→ 内容覆盖方案 §11 全部条目，**可接受偏差**。

## 5. 复现命令

```powershell
cd D:\Projects\i-kit; pnpm -r --if-present build                       # exit 0
node scripts/gen-plugin-key.mjs --out tmp/qa-b6-keys                   # 生成密钥（tmp/ 已 gitignore）
node scripts/sign-plugin.mjs --dir plugins/hello --out tmp/x.zip       # ★ exit 1（AC-4 缺陷）
node scripts/sign-plugin.mjs --zip tmp/hello-unsigned.zip --out tmp/hello-signed.zip --key-file tmp/qa-b6-keys/plugin-signing.key.pem --registry-entry
node scripts/sign-plugin.mjs --verify tmp/hello-signed.zip --pub tmp/qa-b6-keys/plugin-signing.pub.pem   # verified
cd C:\Users\wxov1\AppData\Local\Temp\ikit-ab
node b1.mjs    # 工具链与签名语义：PASS 27 / FAIL 1（唯一 FAIL = AC-4 --dir；日志 b1-run.txt）
node b2.mjs    # 服务端语义（warn/enforce/off/信任表/导出/泄漏）：PASS 42 / FAIL 0（日志 b2-run3.txt）
```

> 说明：`b2.mjs` 有一次运行以 `0xC0000409` 异常退出（输出被重定向到文件时），未重定向复跑两次均完整通过（42/42）；疑为本地进程/重定向环境的偶发问题，不影响结论（两次完整通过，结果一致）。

*本报告所有结论均来自本次独立执行的命令/进程输出，未采信开发者自报的 88 项冒烟；临时密钥已删除，真实 data/plugins 未被触碰。*

---
---

# 第 2 轮复验（聚焦 AC-4 闭环 + 加固项，2026-10-14）

> **范围**：仅复核第 1 轮的「必须修」AC-4（`--dir` 崩溃）与开发者顺带加固项，**不重跑全量**。
> **隔离声明**：脚本位于 `%TEMP%\ikit-ab\r2b1.mjs`；密钥按脚本硬约束写入仓库内 `tmp/qa-b6-r2keys/`（`tmp/` 已被 gitignore），**复验后即刻删除**；字面复跑的 `--out` 也落在 `tmp/`（gitignore）并已删除；`.keys/` 未创建。未改代码、未做 git 写操作。
> **第 2 轮结论**：**PASS** —— 独立检查 **23/23**；AC-4 闭环，「必须修」清零。

## R2-1. 构建

| 命令 | 结果 |
|---|---|
| `pnpm -r --if-present build` | **exit 0**（11/12 项目 `Done`；`apps/web` 含 `vue-tsc` → `✓ built in 2.48s`） |

## R2-2. 逐项复核结果

| # | 复核项 | 判定 | 证据 |
|---|---|---|---|
| ① | **字面复跑原失败命令** | **PASS** | `node scripts/sign-plugin.mjs --dir plugins/hello --out tmp/x-r2.zip --registry-entry --key-file <key>` → **exit 0**，输出 `✅ 已签名并写出: D:\Projects\i-kit\tmp\x-r2.zip`；临时 fixture（`%TEMP%` 包目录）`--dir` 签名同样 exit 0。修复点即开发者所述 `scripts/sign-plugin.mjs:144` `readdirSync(cur, { withFileTypes: true })`（源码注释亦点明「缺它会让 it 变成字符串 ── AC-4 崩溃根因」） |
| ② | `--print-hash --dir` == `--print-hash --zip` == registry 条目 `sha256` | **PASS** | 三者逐字相等（`afe78ae932ee415a…`）；`--print-hash` 双输入（`--zip`+`--dir`）→ **exit 2** + `✗` 提示；registry 条目字段完整（`name/version/packageUrl/sha256/signedHash/signature(86)/keyId`），`signedHash == sha256` |
| ③ | `--verify --dir` 三态与退出码 | **PASS** | 正确信封 → `status: verified` + **exit 0**；无信封参数 → `status: unsigned（目录无签名载体…）` + **exit 0**；篡改内容 + 原信封 → `status: invalid` + **exit 1**；`--verify <zip>` 自动识别 → verified + exit 0；目标不存在 → **exit 2**；缺 `--pub` → `status: unverified（未提供 --pub，仅解析出信封）` + **exit 0**（与脚本头 L23/L49/L88 的退出码约定完全一致，属**文档化行为**） |
| ④ | 回归脚本复跑 | **PASS** | `node scripts/sign-plugin-smoke.mjs` → **exit 0**、末行 `===== 结果：PASS 62 / FAIL 0 =====`；脚本头声明「所有产物写入系统临时目录，不在仓库内生成 `.keys/`、不写 `tmp/`」，且覆盖 `--dir` 四条路径（签名的关键在于它把 `--dir` 纳入回归——这正是第 1 轮遗漏的覆盖面） |
| ⑤ | 构建 | **PASS** | 见 R2-1 |
| ⑥ | 私钥零泄漏 | **PASS** | 脚本与 smoke 的全部输出中**真实 PEM 头（`-----BEGIN … PRIVATE KEY-----`）0 处**（仅出现 smoke 自己的断言标签「✅ 全部子进程输出无 PRIVATE KEY」）；仓库无 `.keys/`；`git status` 无密钥文件；验收后 `tmp/qa-b6-r2keys/` 与 `tmp/x-r2.zip` 已删除 |

## R2-3. 结论与遗留

- **AC-4 已闭环**：第 1 轮的「必须修」在本轮**字面复跑通过**，且新增的 `--dir` 定向回归（62 项）覆盖了此前的盲区。**「必须修」清零。**
- **建议修（1，承接第 1 轮）**：`docs/plugin-signing.md` / `README.md` 应在「快速上手」处**强提示**：远端签名包的 `registry.json` 条目必须携带 `signature/keyId/signedHash`（即把 `--registry-entry` 的输出真正粘进去），否则 enforce 模式下会被**下载前**拒装、列表按「未签名」标注（第 1 轮 E-6 已实测复现；列表页无法读 zip comment，属设计使然）。
- 观察（可忽略）：`--verify` 缺 `--pub` 返回 `unverified` + exit 0 而非 exit 2 —— 已在脚本头明确定义，CI 可据 `status:` 行判定。

## R2-4. 复现命令

```powershell
cd D:\Projects\i-kit
node scripts/gen-plugin-key.mjs --out tmp/qa-b6-r2keys
node scripts/sign-plugin.mjs --dir plugins/hello --out tmp/x-r2.zip --registry-entry --key-file tmp/qa-b6-r2keys/plugin-signing.key.pem   # exit 0（第 1 轮为 exit 1）
node scripts/sign-plugin.mjs --print-hash --dir plugins/hello            # == --print-hash --zip <signed>
node scripts/sign-plugin.mjs --verify --dir plugins/hello --pub tmp/qa-b6-r2keys/plugin-signing.pub.pem --signature <86> --key-id <ikit-…> --signed-hash <64hex>   # verified / exit 0
node scripts/sign-plugin-smoke.mjs                                       # PASS 62 / FAIL 0
cd C:\Users\wxov1\AppData\Local\Temp\ikit-ab
node r2b1.mjs                                                            # PASS 23 / FAIL 0（日志 r2b1-run2.txt）
```

*第 2 轮复验完成；临时密钥与 tmp 产物已删除，真实 data/plugins 未被触碰。*
