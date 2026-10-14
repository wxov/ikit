// 插件注册表错误：带机器可读错误码（路由层 catch 时随响应返回 code，HTTP 仍为 400）
// 说明：错误码常量前后端/文档统一引用，避免文案判断。

/** 插件错误码（响应体 code 字段取值） */
export const PLUGIN_ERR = {
  /** 远端安装/更新缺少 sha256 校验值（下载前拒绝） */
  SHA256_REQUIRED: 'PLUGIN_SHA256_REQUIRED',
  /** sha256 格式非法（非 64 位 hex，下载前拒绝） */
  SHA256_INVALID: 'PLUGIN_SHA256_INVALID',
  /** 内容哈希与声明的 sha256 不一致（下载解压后强比对） */
  SHA256_MISMATCH: 'PLUGIN_SHA256_MISMATCH',
  /** 目录条目声明的版本与包内 plugin.json 版本不一致（F2） */
  STORE_VERSION_MISMATCH: 'PLUGIN_STORE_VERSION_MISMATCH',
  /** enforce 模式下安装/导入的包未携带签名（⑥） */
  SIGNATURE_REQUIRED: 'PLUGIN_SIGNATURE_REQUIRED',
  /** 签名信封字段缺失/格式非法（⑥） */
  SIGNATURE_MALFORMED: 'PLUGIN_SIGNATURE_MALFORMED',
  /** 签名 keyId 不在信任表（⑥） */
  SIGNATURE_KEY_UNKNOWN: 'PLUGIN_SIGNATURE_KEY_UNKNOWN',
  /** signedHash 与内容不一致 / crypto.verify 失败（⑥） */
  SIGNATURE_INVALID: 'PLUGIN_SIGNATURE_INVALID',
} as const

export type PluginErrorCode = (typeof PLUGIN_ERR)[keyof typeof PLUGIN_ERR]

/** 带错误码的插件错误：路由层 `e?.code` 直接透出，普通 Error 仍兼容（code 为 undefined） */
export class PluginError extends Error {
  readonly code: string

  constructor(message: string, code: string = '') {
    super(message)
    this.name = 'PluginError'
    this.code = code
  }
}
