# DeepSeek Harness AI Agent 交付团队配置

本文档说明如何在 DeepSeek Harness（DSH）上配置一支系统、可交付的 AI Agent 团队：**需求提出 → 技术制定与实施 → 测试验收 → 验收反馈回需求 → 修订方案，循环迭代直至功能完成**。

## 1. 配置载体（DSH 原生机制）

DSH 提供四个可组合的编排原语，团队配置由它们拼装而成：

| 机制 | 作用 | 本团队中的角色 |
|---|---|---|
| **Skill（技能）** | 持久化的任务协议：团队角色、闭环流程、交付约定 | 团队章程（本文档配套的 `dev-team` 技能） |
| **Subagent（子代理）** | 独立上下文的角色执行者；后台可续（`send_message` 保持同一会话） | 需求分析师 / 技术负责人 / 开发者 / 测试验收工程师 |
| **Workflow（工作流）** | JS 编排脚本：`agent()` 扇出角色子代理、`phase()` 分阶段、while 循环实现迭代、结构化 JSON 输出（schema 校验） | 全自动闭环执行器（`deliver-loop.js`） |
| **Goal（目标）** | 同会话长期目标 + 自动续轮预算（`max_goal_rounds`） | 跨轮次/跨会话的交付目标驱动 |

> 区分：**Agent Preset**（`~/.dsh/.agent-presets/<id>/agent.cordis.yml`）配置的是"会话挂载哪些工具/提示段"，不是团队角色；本团队配置不需要它。

## 2. 已配置的文件

| 文件 | 说明 |
|---|---|
| `.dsh/skills/dev-team/SKILL.md` | 团队技能：4 角色定义、闭环协议、两种运行模式、终止条件、交付约定 |
| `.dsh/skills/dev-team/scripts/deliver-loop.js` | 闭环迭代 workflow 脚本（需求→方案→实施→验收→反馈循环） |
| `docs/deepseek-harness AI Agent 交付团队配置.md` | 本文档 |

技能目录 `.dsh/skills` 位于项目根（含 `.git` 的最近祖先），DSH 启动时自动扫描并热加载（Chokidar 监听 + 文件工具写后即时失效），因此**配置即生效，无需重启**。全局复用可复制到 `~/.dsh/skills/`。

## 3. 团队与闭环

### 3.1 角色

| 角色 | 承担者 | 输入 | 输出 |
|---|---|---|---|
| 需求分析师 | 子代理 | 用户目标 + 上轮验收反馈 | PRD（功能点、验收标准 AC、范围、风险）→ `docs/ai-delivery/PRD.md` |
| 技术负责人 | 子代理 | PRD | 技术方案 + 关联影响检查 + 改动清单 → `docs/ai-delivery/tech-plan.md` |
| 开发者 | 子代理 | 技术方案 | 代码实现 + 构建自检报告 |
| 测试验收工程师 | 子代理 | AC + 实现结果 | 验收报告：逐项 AC pass/fail + 真实验证证据 → `docs/ai-delivery/acceptance-report-N.md` |
| 协调者 | 主 agent | 全部产物 | 循环调度、人机确认门、交付汇总 |

### 3.2 闭环协议

```
第 N 轮：
  需求 → 方案（人机确认门）→ 实施 → 验收 → 判定
    ├─ 全部 AC 通过 → 交付（汇总报告 + 改动清单 + 文档同步）
    └─ 存在失败项 → 失败 AC + 缺陷反馈回需求分析师 → 第 N+1 轮
```

**终止条件**：全部 AC 通过；或达轮次上限（默认 5）；或连续两轮失败项无变化（无进展，上报阻塞原因）。

## 4. 使用方式

### 4.1 触发团队技能

- **自动**：任务描述与技能 `description` 匹配时（"组建团队""需求-开发-测试闭环""循环直到功能完成"），主 agent 自动加载 `dev-team` 技能；
- **显式**：在输入中键入 `/dev-team`（用户可调用手势），或直接说"用 dev-team 团队技能做 X"。

### 4.2 模式 A：协调模式（默认，推荐）

主 agent 任协调者，逐轮派发子代理执行各角色；QA 失败时把验收报告全文发回需求分析师。关键节点保留**人机确认门**：

1. 需求产出 PRD 后 → 向用户确认范围与验收标准；
2. 技术方案产出后 → 展示关联影响清单，用户确认后再实施（符合 `AGENTS.md`「先询问再修改」）；
3. 验收通过后 → 展示交付汇总，**不自动**提交/合并/部署，等用户确认。

长任务配套 `create_goal`：objective 写明交付目标与轮次预算，DSH 会自动跨轮次续跑；会话恢复后用 `update_goal(action: 'resume')` 重新武装。

### 4.3 模式 B：工作流模式（全自动）

目标明确、无需中途确认时，用 workflow 工具运行 `scripts/deliver-loop.js`（脚本内容作为 `script` 参数）：

```js
// meta
{ name: 'deliver-loop',
  description: '需求→方案→实施→验收 闭环迭代直至交付',
  phases: [ { title: '需求分析' }, { title: '技术方案' }, { title: '实施' }, { title: '测试验收' } ] }

// args
{ objective: '<用户目标原文>',
  maxRounds: 5,
  artifactsDir: 'docs/ai-delivery',
  verifyCommands: ['pnpm -r --if-present build'],
  extraContext: '<AGENTS.md 要点等补充背景>' }
```

脚本每轮产出结构化结果（PRD / 方案 / 实施 / 验收，JSON Schema 校验），验收通过返回 `{ ok: true, rounds, history }`；失败返回 `ok: false` + 原因（角色失败 / 无进展 / 达轮次上限），由协调者接管上报。

### 4.4 长期团队会话（可选）

需要角色保留记忆（如 QA 对同一需求的跨轮次追踪）时，用后台子代理建立持久角色会话，通过 `send_message` 把后续轮次工作发给同一子代理，`list_agents` 查看团队状态。

## 5. 与 i-kit 项目规范的集成

- 分支规范：开发一律在 `develop`，技术方案中注明；
- 关联影响检查：技术负责人强制执行（依赖、共享契约、前端联动、配置项、存储迁移）；
- 先询问再修改：方案确认门保证；
- 文档同步：每轮产物落在 `docs/ai-delivery/`，功能变更同步对应文档；
- 禁止自动 git 提交/推送、合并、打包、部署：技能协议明确要求用户确认。

## 6. 扩展

- **增加角色**（如安全评审）：在 `SKILL.md` 角色表与闭环协议中插入新阶段，在 `deliver-loop.js` 对应位置加一个 `agent()` 调用与 schema；
- **调整轮次上限**：改 `args.maxRounds`（脚本硬上限 10，防止失控）；
- **换验证命令**：`args.verifyCommands` 传项目实际命令（如 `pnpm -r --if-present build; pnpm test`）；
- **全局生效**：把 `.dsh/skills/dev-team` 复制到 `~/.dsh/skills/`，所有项目可用。
