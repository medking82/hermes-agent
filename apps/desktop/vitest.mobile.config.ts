import path from 'node:path'

import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, 'src') },
      { find: /^@hermes\/shared$/, replacement: path.resolve(import.meta.dirname, '../shared/src/index.ts') }
    ]
  },
  test: { include: ['mobile/**/*.test.{ts,tsx}'], environment: 'jsdom', globals: false }
})
