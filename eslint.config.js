import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'resources/**', '_site/**', 'site/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // 13.10: personal (local) storage must never touch the network.
    files: ['src/main/localdb/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['http', 'https', 'node:http', 'node:https', 'ws', 'node:net', 'net', 'electron-updater'],
          patterns: ['**/server/**', '**/lib/api*']
        }
      ],
      'no-restricted-globals': ['error', 'fetch', 'WebSocket', 'XMLHttpRequest'],
      'no-restricted-properties': ['error', { object: 'electron', property: 'net' }]
    }
  }
)
