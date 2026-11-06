import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Same aliases and SDK source resolution as the app; a browser-like DOM for the pages.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      environmentOptions: { happyDOM: { url: 'http://localhost:3000/app' } },
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/dashboard/test/setup.ts'],
      // Cold first runs transform React, happy-dom and the pages inside the first test.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      restoreMocks: true,
    },
  }),
)
