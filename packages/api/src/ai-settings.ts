// AI 运行时设置（2026-11-28，M3）
//
// 存储：data/ai-settings.json（可用 AI_SETTINGS_FILE 覆盖），原子写。
// 读取：每次调用现读（文件很小），避免缓存不一致；写入做归一化与范围钳制。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type SkillVariantMode = 'off' | 'a' | 'b' | 'auto'
export type PolishIntensity = 'light' | 'standard' | 'deep'
export type PolishStyle = 'plain' | 'literary'

export interface AiSettings {
  /** 是否允许小知「✨优化」（关闭后接口返回 E_DISABLED） */
  promptPolish: boolean
  /** 技能 A/B：off=关闭；a/b=强制；auto=按 userId 稳定 50/50 */
  skillVariant: SkillVariantMode
  /** 会话摘要触发阈值（消息条数，含用户与助手） */
  summaryThreshold: number
  /** 摘要时保留的最近消息条数 */
  summaryKeep: number
  /** 拾光默认强度（请求未显式传时生效） */
  polishIntensity: PolishIntensity
  /** 拾光默认风格 */
  polishStyle: PolishStyle
  /** 拾光默认候选数（1=单版，2=双版） */
  dualVariantsDefault: 1 | 2
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  promptPolish: true,
  skillVariant: 'auto',
  summaryThreshold: 16,
  summaryKeep: 8,
  polishIntensity: 'standard',
  polishStyle: 'plain',
  dualVariantsDefault: 1,
}

export function aiSettingsFile(): string {
  return process.env.AI_SETTINGS_FILE ?? './data/ai-settings.json'
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const INTENSITIES: PolishIntensity[] = ['light', 'standard', 'deep']
const STYLES: PolishStyle[] = ['plain', 'literary']
const VARIANTS: SkillVariantMode[] = ['off', 'a', 'b', 'auto']

/** 归一化：非法值回落 base；阈值/保留条数做范围钳制，并保证 keep < threshold */
export function normalizeAiSettings(input: unknown, base: AiSettings = DEFAULT_AI_SETTINGS): AiSettings {
  const o = (input ?? {}) as Record<string, unknown>
  const threshold = clampInt(o.summaryThreshold, 4, 100, base.summaryThreshold)
  const keep = clampInt(o.summaryKeep, 2, 40, base.summaryKeep)
  return {
    promptPolish: typeof o.promptPolish === 'boolean' ? o.promptPolish : base.promptPolish,
    skillVariant: VARIANTS.includes(o.skillVariant as SkillVariantMode)
      ? (o.skillVariant as SkillVariantMode)
      : base.skillVariant,
    summaryThreshold: threshold,
    summaryKeep: Math.min(keep, Math.max(2, threshold - 1)),
    polishIntensity: INTENSITIES.includes(o.polishIntensity as PolishIntensity)
      ? (o.polishIntensity as PolishIntensity)
      : base.polishIntensity,
    polishStyle: STYLES.includes(o.polishStyle as PolishStyle) ? (o.polishStyle as PolishStyle) : base.polishStyle,
    dualVariantsDefault: o.dualVariantsDefault === 2 ? 2 : 1,
  }
}

/** 读取设置；文件不存在/损坏 → 默认值 */
export function loadAiSettings(file: string = aiSettingsFile()): AiSettings {
  try {
    if (!existsSync(file)) return { ...DEFAULT_AI_SETTINGS }
    const raw = readFileSync(file, 'utf-8')
    return normalizeAiSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_AI_SETTINGS }
  }
}

/** 合并写入（部分更新），原子写 tmp+rename；返回保存后的完整设置 */
export function saveAiSettings(patch: unknown, file: string = aiSettingsFile()): AiSettings {
  const next = normalizeAiSettings(patch, loadAiSettings(file))
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, file)
  return next
}

/** 稳定哈希（FNV-1a 简化版），用于 A/B 分桶 */
export function hashUserId(userId: string): number {
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 解析当前用户应使用的技能变体：off→undefined；a/b→固定；auto→稳定 50/50 */
export function resolveSkillVariant(userId: string | undefined, mode: SkillVariantMode): 'a' | 'b' | undefined {
  if (mode === 'off') return undefined
  if (mode === 'a' || mode === 'b') return mode
  if (!userId) return undefined
  return hashUserId(userId) % 2 === 0 ? 'a' : 'b'
}
