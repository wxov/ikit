// 轻量结构化日志（P2-13，2026-11-28）
//
// 目标：把散落的 console.* 收敛到统一出口，支持通过 LOG_LEVEL 控制噪声（生产默认 info）。
// 设计取舍：零依赖、同步输出、格式固定为 `[ISO时间] [级别] [模块] 消息`，便于 grep 与后续接入采集。
// 注意：级别在 createLogger() 时读取一次（进程内固定）；测试可先设 process.env.LOG_LEVEL 再创建。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

/** 读取当前阈值（非法值按 info 处理） */
export function currentLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase()
  return raw in WEIGHT ? (raw as LogLevel) : 'info'
}

/** 指定级别在给定阈值下是否输出（导出便于单测） */
export function isLevelEnabled(level: Exclude<LogLevel, 'silent'>, threshold: LogLevel = currentLogLevel()): boolean {
  if (threshold === 'silent') return false
  return WEIGHT[level] >= WEIGHT[threshold]
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** 创建带模块前缀的 logger（scope 形如 `knowledge` / `plugin-registry/loader`） */
export function createLogger(scope: string): Logger {
  const threshold = currentLogLevel()
  const emit = (level: Exclude<LogLevel, 'silent'>, args: unknown[]): void => {
    if (!isLevelEnabled(level, threshold)) return
    const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${args.map(formatArg).join(' ')}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  }
}
