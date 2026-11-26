import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', '.claude/**', 'node_modules/**', 'resources/plugins/**', 'resources/data/**', '_site/**', 'site/**'] },
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
    // Plugins and the built-in ledger screen are plain browser scripts running in a sandboxed frame.
    files: ['plugins/**/*.js', 'resources/ledger/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } }
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
    files: ['command/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // 긴급구조지휘대 (command/) stands on its own: it may later run without TeamHub, so it never
    // imports the host's code (the host gives what it needs through command/*/host.ts).
    files: ['command/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/src/**', '@renderer/*', '@shared/*', '@renderer', '@shared'] }]
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
