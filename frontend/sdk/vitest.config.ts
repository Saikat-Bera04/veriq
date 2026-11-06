import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^veriq-client\/styles\.css$/, replacement: src('react/styles.css') },
      { find: /^veriq-client\/react$/, replacement: src('react/index.ts') },
      { find: /^veriq-client$/, replacement: src('index.ts') },
      { find: /^@veriq\/sdk\/styles\.css$/, replacement: src('react/styles.css') },
      { find: /^@veriq\/sdk\/react$/, replacement: src('react/index.ts') },
      { find: /^@veriq\/sdk$/, replacement: src('index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // A cold first run transforms each example's imports (viem, React, happy-dom)
    // inside the first test; that alone can pass vitest's 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'] },
  },
})
