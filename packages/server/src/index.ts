import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createCore } from '@ikit/core'
import { createApi } from '@ikit/api'

// 读取当前版本（来自 packages/server/package.json）
let APP_VERSION = '0.1.3'
try {
  const pkg = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'),
  ) as { version?: string }
  if (pkg.version) APP_VERSION = pkg.version
} catch {
  /* ignore */
}

// 加载 .env（从当前目录向上查找，项目根的 .env 优先），已存在的环境变量优先
function findEnvFile(): string | undefined {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, '.env')
    if (existsSync(f)) return f
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function loadEnv() {
  const envFile = findEnvFile()
  if (!envFile) return
  try {
    const content = readFileSync(envFile, 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!m || line.trim().startsWith('#')) continue
      const key = m[1]
      const val = m[2].replace(/^["']|["']$/g, '')
      if (!(key in process.env)) process.env[key] = val
    }
    console.log(`[server] loaded env from ${envFile}`)
  } catch (e) {
    console.warn('[server] failed to load .env:', e instanceof Error ? e.message : e)
  }
}
loadEnv()

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

// 前端静态目录（生产托管）：默认 apps/web/dist，可用 WEB_DIST 覆盖
// 注：pnpm --filter 在包目录运行，process.cwd() = packages/server
const defaultDist = path.resolve(process.cwd(), '../../apps/web/dist')
const staticRoot = process.env.WEB_DIST ?? (existsSync(defaultDist) ? defaultDist : undefined)
// 热更新分发包根目录：项目根/update（含 <version>/web-update.zip）
const defaultUpdate = path.resolve(process.cwd(), '../../update')
const updateRoot = existsSync(defaultUpdate) ? defaultUpdate : undefined

// 初始管理员密码（P1-3，2026-11-28）：
// - 未设置 ADMIN_PASSWORD → 生成随机密码并打印一次（仅「管理员不存在、首次 seed」时生效，不影响已有安装）；
// - 仍为 admin123 → 保留但告警，避免用户显式设置时被意外改写。
function resolveAdminPassword(): string {
  const fromEnv = (process.env.ADMIN_PASSWORD ?? '').trim()
  if (!fromEnv) {
    const generated = randomBytes(9).toString('base64url')
    console.warn(
      '[account] 未设置 ADMIN_PASSWORD：若管理员尚不存在，将用以下随机密码创建（请登录后立即修改）：\n' +
        `[account]   ${generated}`,
    )
    return generated
  }
  if (fromEnv === 'admin123') {
    console.warn('[account] 检测到 ADMIN_PASSWORD 为弱密码 admin123，强烈建议更换（当前按配置使用）。')
  }
  return fromEnv
}

async function main() {
  const ctx = await createCore({
    knowledge: {
      dataDir: './data',
      storage: process.env.KB_STORAGE === 'sqlite' ? 'sqlite' : 'json',
    },
    registry: {
      dataDir: './data',
      pluginDir: process.env.PLUGIN_DIR ?? path.resolve(process.cwd(), '../../plugins'),
    },
    account: {
      dataDir: './data',
      adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
      adminPassword: resolveAdminPassword(),
      smtp: {
        host: process.env.SMTP_HOST ?? '',
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === '1',
        user: process.env.SMTP_USER ?? '',
        pass: process.env.SMTP_PASS ?? '',
        from: process.env.SMTP_FROM ?? '',
      },
      appUrl: process.env.APP_URL ?? '',
    },
    storeData: {
      dataDir: './data',
    },
    shiguang: {
      dataDir: './data',
    },
    agent: {
      dataDir: './data',
      // 写类工具（新增/修改文档）等待确认的超时；测试时可用环境变量缩短
      approvalTimeoutMs: Number(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? '120000'),
    },
    llm: {
      apiBase: process.env.LLM_API_BASE ?? 'https://api.deepseek.com',
      apiKey: process.env.LLM_API_KEY ?? '',
      model: process.env.LLM_MODEL ?? 'deepseek-chat',
      embeddingApiBase: process.env.EMBEDDING_API_BASE ?? 'https://api.siliconflow.cn/v1',
      embeddingApiKey: process.env.EMBEDDING_API_KEY ?? '',
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'BAAI/bge-m3',
      // 模型清单（小知模型配置与选择）存储路径；默认 ./data/llm-models.json（随 data 卷持久化）
      modelsFile: process.env.LLM_MODELS_FILE || undefined,
    },
  })

  const app = await createApi(ctx, {
    name: 'i-kit',
    version: APP_VERSION,
    plugins: [
      { name: 'llm', version: APP_VERSION },
      { name: 'demo', version: APP_VERSION },
      { name: 'knowledge', version: APP_VERSION },
      { name: 'agent', version: APP_VERSION },
      { name: 'plugin-registry', version: APP_VERSION },
      { name: 'account', version: APP_VERSION },
      { name: 'store-data', version: APP_VERSION },
    ],
    staticRoot,
    updateRoot,
    uploadsDir: path.resolve(process.cwd(), 'data', 'uploads'),
  })

  await app.listen({ port: PORT, host: HOST })
  console.log(`[server] i-kit listening on http://localhost:${PORT}`)
  console.log(`[server] WebSocket endpoint: ws://localhost:${PORT}/ws`)
  if (staticRoot) {
    console.log(`[server] serving static files from: ${staticRoot}`)
  }
  if (updateRoot) {
    console.log(`[server] serving update bundles from: ${updateRoot}`)
  }
}

main().catch((err) => {
  console.error('[server] fatal error:', err)
  process.exit(1)
})
