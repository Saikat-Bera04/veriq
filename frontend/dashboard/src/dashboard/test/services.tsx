/**
 * Test doubles for the two local services the dashboard talks to, behind its
 * same-origin proxies: the engine (/engine) and the demo attacker (/attacker).
 * Every request goes through a stubbed global fetch; nothing touches the network.
 */
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import receiptSample from '../../../../../fixtures/receipt-sample.json'

/** The real, Helios-verified receipt shared with the Rust and SDK tests. */
export const RECEIPT = receiptSample

export const HONEST_WEI = 2_000_000_000_000_000_000n // 2 ETH
export const INFLATED_WEI = HONEST_WEI + 1_000_000_000_000_000_000_000n // +1000 ETH

export const healthBody = {
  status: 'ok',
  ok: true,
  bind: '127.0.0.1:8547',
  chainId: 11155111,
  rootSource: 'local-light-client',
  devMode: false,
  providerCount: 1,
  providers: [
    { name: 'alchemy', chainOk: true, proofSupport: true, eip1898: true, transport: 'direct', breaker: { state: 'closed' }, successRate: 1 },
  ],
  lightClient: { synced: true, finalizedNumber: RECEIPT.block.number, finalizedHash: RECEIPT.block.hash },
  error: null,
}

/** A stored row as GET /receipts returns it (store.rs), around the real receipt. */
export const receiptRow = {
  id: RECEIPT.identity.requestId,
  createdAt: RECEIPT.freshness.observedAt * 1000,
  method: 'veriq_readBalance',
  params: { address: '0x0000000000000000000000000000000000000000' },
  value: `0x${HONEST_WEI.toString(16)}`,
  blockNumber: RECEIPT.block.number,
  receipt: RECEIPT,
  attempts: RECEIPT.routing.attempts,
}

type Rpc = { result: unknown } | { error: { code: number; message: string; data?: unknown } }
export type Unreachable = 'unreachable'

export interface Services {
  /** GET /engine/health; 'unreachable' rejects like a dead proxy target. */
  health?: () => unknown | Unreachable
  receipts?: () => unknown | Unreachable
  /** POST /engine JSON-RPC. */
  engineRpc?: (method: string, params: unknown[]) => Rpc | Unreachable
  /** GET /attacker/mode. */
  attackerMode?: () => string | Unreachable
  /** POST /attacker/mode -> HTTP status (default 200). */
  setAttackerMode?: (mode: string) => number
  /** POST /admin/reset-breakers on the engine's loopback -> HTTP status (default 200, a demo build). */
  resetBreakers?: () => number
  /** POST /attacker eth_getBalance. */
  attackerBalance?: () => Rpc | { status: number }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Install a fetch stub serving `services`; returns the recorded requests. */
export function serve(services: Services) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const fail = (): never => {
      throw new TypeError('Failed to fetch')
    }
    const answer = <T,>(value: T | Unreachable): T => (value === 'unreachable' ? fail() : value)

    if (url.startsWith('/engine/health')) return json(answer((services.health ?? (() => 'unreachable'))()))
    if (url.startsWith('/engine/receipts')) {
      return services.receipts ? json(answer(services.receipts())) : new Response('not found', { status: 404 })
    }
    if (url === '/engine' || url === '/engine/') {
      const rpc = body as { id: number; method: string; params: unknown[] }
      const out = answer((services.engineRpc ?? (() => 'unreachable'))(rpc.method, rpc.params))
      return json({ jsonrpc: '2.0', id: rpc.id, ...out })
    }
    if (url === '/attacker/mode' && method === 'GET') {
      const mode = answer((services.attackerMode ?? (() => 'unreachable'))())
      return json({ mode, available: ['off', 'value', 'proof', 'wrongblock', 'outage', 'nonce', 'code'] })
    }
    if (url === '/admin/reset-breakers' && method === 'POST') {
      const status = (services.resetBreakers ?? (() => 200))()
      return json({ reset: status < 400, wereCoolingDown: 1 }, status)
    }
    if (url === '/attacker/mode' && method === 'POST') {
      const status = (services.setAttackerMode ?? (() => 200))((body as { mode: string }).mode)
      return json({ ok: status < 400 }, status)
    }
    if (url === '/attacker' || url === '/attacker/') {
      const out = (services.attackerBalance ?? (() => ({ result: `0x${HONEST_WEI.toString(16)}` })))()
      if ('status' in out) return new Response('upstream down', { status: out.status, statusText: 'Service Unavailable' })
      return json({ jsonrpc: '2.0', id: 1, ...out })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

/** A verified veriq_readBalance answer, carrying the real receipt. */
export function verifiedRead(valueWei = HONEST_WEI): Rpc {
  return {
    result: {
      value: `0x${valueWei.toString(16)}`,
      receipt: RECEIPT,
      attempts: [
        { provider: 'attacker', outcome: 'invalid-proof', elapsedMs: 40, reason: 'account proof does not chain to pinned stateRoot' },
        { provider: 'alchemy', outcome: 'success', elapsedMs: 900 },
      ],
    },
  }
}

export function renderPage(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}
