// ESLint 扁平配置（P2-9，2026-11-28）
//
// 目标：以「正确性」为主的最小规则集，先让 `pnpm lint` 稳定为绿，再逐步收紧。
// 说明：
// - 关闭 `no-explicit-any`：存量有 146 处显式 any（评审文档 P2 记录），逐步治理，不阻塞 CI；
// - 关闭 `no-console`：日志统一走 @ikit/shared logger，其内部实现必须用 console；
// - Vue 用 `flat/essential`（仅正确性规则），避免引入大量格式类规则造成历史代码大改；
// - 格式统一交给 Prettier（`.prettierrc.json`），ESLint 不重复管格式。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/tmp/**',
      '**/dsh-browser-shots/**',
      '**/update/**',
      'apps/web/src-tauri/**',
      'apps/web/android/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
)
