import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

beforeEach(() => {
  // Anon-RPC is on in the app by default. Tests start with it off (the direct path) and a fresh
  // worker singleton; anon tests switch it on with vi.stubEnv('VITE_ANON', 'on').
  vi.stubEnv('VITE_ANON', 'off')
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('veriq.dashboard.anon')]
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
