import { vi } from 'vitest'
import type { Attempt, EngineHealth, TrustReceipt } from 'veriq-client'

export const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const h = (c: string) => `0x${c.repeat(64)}`

/** A receipt exactly as receipt.rs serializes it. */
export function receiptFixture(over: Partial<TrustReceipt> = {}): TrustReceipt {
  return {
    identity: { requestId: 'req-1', method: 'veriq_readBalance', requestBinding: 'ab'.repeat(32), resultBinding: 'cd'.repeat(32) },
    block: { number: 7412903, hash: `0x9a3f${'0'.repeat(56)}c21e`, stateRoot: `0x51be${'1'.repeat(56)}07aa`, finalized: true },
    verification: {
      status: 'verified',
      rootSource: 'local-light-client',
      verifierLocation: 'local-engine',
      mechanisms: ['account-proof'],
      bootstrap: { source: 'helios', checkpoint: h('c'), checkpointSource: 'config/checkpoint.toml' },
    },
    privacy: { transport: 'direct', mechanism: null },
    routing: { comparison: 'not-run', providersTried: 2, providerLabel: 'alchemy', attempts: [] },
    freshness: { observedAt: 1_761_000_000, ageSeconds: 770, pinned: true },
    warnings: [],
    ...over,
  }
}

export const ATTEMPTS: Attempt[] = [
  { provider: 'infura-bad', outcome: 'INVALID_PROOF', elapsedMs: 96, reason: 'account proof does not chain to pinned stateRoot' },
  { provider: 'alchemy', outcome: 'ok', elapsedMs: 88 },
]

export function healthFixture(over: Partial<EngineHealth> = {}): EngineHealth {
  return {
    ok: true,
    bind: '127.0.0.1:8547',
    rootSource: 'local-light-client',
    devMode: false,
    providerCount: 1,
    providers: [{ name: 'alchemy', chainOk: true, proofSupport: true, eip1898: true, transport: 'direct', breaker: { state: 'closed' }, successRate: 1 }],
    lightClient: { synced: true, finalizedNumber: 7412903, finalizedHash: h('a'), headNumber: 7412967 },
    ...over,
  }
}

type Answer = { result: unknown; veriq?: unknown } | { error: { code: number; message: string; data?: unknown } }
export type Handler = (method: string, params: unknown[]) => Answer
export type GetHandler = (path: string) => unknown

/** A fetch stand-in for the engine. Records every call; never touches the network. */
export function mockEngine(rpc: Handler, get: GetHandler = () => healthFixture()) {
  const calls: { method: string; params: unknown[] }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!init || init.method === 'GET') {
      const path = url.replace(/^https?:\/\/[^/]+/, '')
      return new Response(JSON.stringify(get(path)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
    calls.push({ method: body.method, params: body.params })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...rpc(body.method, body.params) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { fetch: fetchMock as unknown as typeof fetch, mock: fetchMock, calls }
}

/** Standard happy-path engine: 2 ETH, proven, with one rejected attempt. */
export const happyEngine: Handler = (method, params) => {
  if (method === 'veriq_readBalance') return { result: { value: '0x1bc16d674ec80000', receipt: receiptFixture(), attempts: ATTEMPTS } }
  if (method === 'veriq_readStorage') {
    return { result: { value: '0x2a', receipt: receiptFixture({ identity: { ...receiptFixture().identity, method: 'veriq_readStorage' } }), attempts: [] } }
  }
  if (method === 'veriq_getReceipt') return { result: receiptFixture({ identity: { ...receiptFixture().identity, requestId: String(params[0]) } }) }
  if (method === 'eth_chainId') return { result: '0xaa36a7' }
  // Standard reads: value in `result`, receipt in the top-level `veriq` member (rpc.rs).
  if (method === 'eth_getTransactionCount') return { result: '0x7', veriq: receiptFixture({ identity: { ...receiptFixture().identity, method: 'eth_getTransactionCount' } }) }
  if (method === 'eth_getCode') return { result: '0x6001', veriq: receiptFixture({ identity: { ...receiptFixture().identity, method: 'eth_getCode' } }) }
  return { error: { code: -32012, message: `${method} is not supported` } }
}
