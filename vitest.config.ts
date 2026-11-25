import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname


export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer')
    }
  },
  test: {
    include: ['tests/**/*.test.ts', 'command/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000
  }
})
