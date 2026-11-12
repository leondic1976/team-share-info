import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = import.meta.dirname

const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@renderer': resolve(root, 'src/renderer')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      // rrule ships CommonJS as "main"; bundle its ESM build instead of importing it at runtime.
      externalizeDeps: { exclude: ['rrule'] },
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          server: resolve(root, 'src/server/index.ts'),
          sysworker: resolve(root, 'src/main/sysutil/worker.ts'),
          fsindexer: resolve(root, 'src/main/files/indexer-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(root, 'src/renderer/index.html') } }
    }
  }
})
