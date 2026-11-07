import { defaultClientConditions, defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The dashboard talks to local services through same-origin proxies, so the
// browser never needs CORS: /engine -> Veriq engine, /attacker -> demo attacker.
// An empty value (unfilled .env line) means the default.
const ENGINE = process.env.VERIQ_ENGINE_URL || 'http://127.0.0.1:8547'
const ATTACKER = process.env.VERIQ_ATTACKER_URL || 'http://127.0.0.1:9545'

const proxy: Record<string, ProxyOptions> = {
  '/engine': {
    target: ENGINE,
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/engine/, '') || '/',
    // Never forward the engine's demo-only admin routes: the dev server can be
    // started with --host (reachable from other machines), the engine cannot.
    bypass: (req) => (req.url?.startsWith('/engine/admin') ? false : undefined),
  },
  '/attacker': {
    target: ATTACKER,
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/attacker/, '') || '/',
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: /^(?:@kirann_out\/)?veriq-client\/styles\.css$/, replacement: fileURLToPath(new URL('../sdk/src/react/styles.css', import.meta.url)) },
      { find: /^(?:@kirann_out\/)?veriq-client\/react$/, replacement: fileURLToPath(new URL('../sdk/src/react/index.ts', import.meta.url)) },
      { find: /^(?:@kirann_out\/)?veriq-client\/verifier\.wasm(\?.*)?$/, replacement: `${fileURLToPath(new URL('../sdk/wasm/veriq_verifier.wasm', import.meta.url))}$1` },
      { find: /^(?:@kirann_out\/)?veriq-client$/, replacement: fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) },
    ],
    // Use veriq-client's TypeScript source in the workspace (no SDK build step needed for dev).
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    port: 3000,
    open: false,
    proxy,
  },
  preview: {
    port: 3000,
    proxy,
  },
})
