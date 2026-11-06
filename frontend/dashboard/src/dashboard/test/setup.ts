import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { resetBrowserLightClientForTests } from '../lib/lightclient'

// Node >= 25 defines its own global localStorage, undefined without --localstorage-file, which
// hides happy-dom's. Give the tests an in-memory one when that happens.
if (typeof globalThis.localStorage === 'undefined') {
  const items = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}

beforeEach(() => {
  // Anon-RPC is on in the app by default. Tests start with it off (the direct path) and a fresh
  // worker singleton; anon tests switch it on with vi.stubEnv('VITE_ANON', 'on').
  vi.stubEnv('VITE_ANON', 'off')
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('veriq.dashboard.anon')]
  // Browser Helios (S4) likewise starts off; lightclient tests switch it on.
  vi.stubEnv('VITE_BROWSER_LIGHT_CLIENT', 'off')
  vi.stubEnv('VITE_BROWSER_VERIFIER', 'off')
  localStorage.removeItem('veriq.browserHelios.v1')
  localStorage.removeItem('veriq.browserHelios.v1.mainnet')
  // S6: tests read Sepolia unless they switch.
  vi.stubEnv('VITE_CHAIN', 'sepolia')
  vi.stubEnv('VITE_ANON_NETWORK', '')
})

afterEach(() => {
  cleanup()
  resetBrowserLightClientForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
