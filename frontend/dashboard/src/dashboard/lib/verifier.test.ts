/**
 * (Paths are relative to frontend/dashboard, where vitest runs.)
 *
 * S5 in the dashboard: the real verifier .wasm (veriq-client/verifier.wasm) checks a real Sepolia
 * proof (fixtures/demo-storage.json) that a fake Nox worker serves, before the engine is asked.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAnonForTests, type AnonWorker } from './anon'
import { getLocalReceipt, readStorage } from './engine'
import { resetBrowserLightClientForTests, startBrowserLightClient, type HeliosLike } from './lightclient'
import { ANON_RECEIPT } from '../test/services'

const demo = JSON.parse(readFileSync(resolve(process.cwd(), '../../fixtures/demo-storage.json'), 'utf8')) as {
  address: string
  block: { number: number; hash: string; stateRoot: string }
  proof: { storageProof: { value: string }[] }
}
const WASM = readFileSync(resolve(process.cwd(), '../sdk/wasm/veriq_verifier.wasm'))
const ROOT = { ...demo.block, rootSource: 'local-light-client', verified: true }

type Engine = 'up' | 'down'

/** Fake Nox serving `proof`; the page's own fetch serves the .wasm and the engine. */
function services(opts: { engine: Engine; proof?: unknown; wasm?: 'ok' | 'missing' }) {
  const verifyInputs: Record<string, unknown>[] = []
  const worker: AnonWorker = {
    ready: Promise.resolve(),
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: opts.proof ?? demo.proof }))
    }),
    close: vi.fn(),
  }
  resetAnonForTests(() => worker)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('verifier.wasm') || url.endsWith('.wasm')) {
        return opts.wasm === 'missing' ? new Response('not found', { status: 404 }) : new Response(WASM, { headers: { 'content-type': 'application/wasm' } })
      }
      if (opts.engine === 'down') throw new TypeError('Failed to fetch')
      const rpc = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown>[] }
      if (rpc.method === 'veriq_getRoot') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: ROOT })
      if (rpc.method === 'veriq_verifyProof') {
        verifyInputs.push(rpc.params[0]!)
        const receipt = { ...ANON_RECEIPT, block: { ...demo.block, finalized: true }, verification: { ...ANON_RECEIPT.verification, verifierLocation: rpc.params[0]!.verifier === 'browser' ? 'browser' : 'local-engine' } }
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { value: '0x2a', receipt } })
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown' } })
    }),
  )
  return { verifyInputs, worker }
}

beforeEach(() => {
  vi.stubEnv('VITE_ANON', 'on')
  vi.stubEnv('VITE_BROWSER_VERIFIER', 'on')
})

describe('browser verifier in the dashboard', () => {
  it('a valid proof is checked in the browser, then by the engine, and the receipt says browser', async () => {
    const s = services({ engine: 'up' })
    const out = await readStorage(demo.address, '0x0')
    expect(out.ok).toBe(true)
    expect(out.ok && BigInt(out.result.value)).toBe(42n)
    expect(s.verifyInputs[0]).toMatchObject({ verifier: 'browser', blockHash: demo.block.hash })
    expect(out.ok && out.result.receipt.verification.verifierLocation).toBe('browser')
  })

  it('a forged proof is rejected in the browser; the engine is never asked to verify it', async () => {
    const lie = JSON.parse(JSON.stringify(demo.proof)) as typeof demo.proof
    lie.storageProof[0]!.value = '0x2b'
    const s = services({ engine: 'up', proof: lie })
    const out = await readStorage(demo.address, '0x0')
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error.name).toBe('InvalidProofError')
    expect(!out.ok && out.error.message).toMatch(/rejected in the browser/)
    expect(s.verifyInputs).toHaveLength(0)
  })

  it('the .wasm does not load: the engine verifies alone and is told so', async () => {
    const s = services({ engine: 'up', wasm: 'missing' })
    const out = await readStorage(demo.address, '0x0')
    expect(out.ok).toBe(true)
    expect(s.verifyInputs[0]).toMatchObject({ verifier: 'unavailable' })
  })

  it('engine down, browser Helios synced: a local-only receipt, kept for the receipt drawer', async () => {
    services({ engine: 'down' })
    // Browser Helios, faked as synced at the fixture's block; its checkpointz request goes
    // through this worker too.
    vi.stubEnv('VITE_BROWSER_LIGHT_CLIENT', 'on')
    const worker = {
      ready: Promise.resolve(),
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/checkpointz/')) {
          return Response.json({ data: { upstreams: { a: { healthy: true, finality: { finalized: { root: `0x${'c1'.repeat(32)}` } } } } } })
        }
        const body = JSON.parse(String(init?.body)) as { id: number }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: demo.proof })
      }),
      close: vi.fn(),
    }
    resetAnonForTests(() => worker)
    const helios: HeliosLike = {
      waitSynced: async () => {},
      request: async ({ method }) =>
        method === 'eth_getBlockByNumber'
          ? { number: `0x${demo.block.number.toString(16)}`, hash: demo.block.hash, stateRoot: demo.block.stateRoot, timestamp: `0x${Math.floor(Date.now() / 1000 - 900).toString(16)}` }
          : `0x${'c2'.repeat(32)}`,
    }
    resetBrowserLightClientForTests(async () => helios)
    await startBrowserLightClient()

    const out = await readStorage(demo.address, '0x0')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(BigInt(out.result.value)).toBe(42n)
    const r = out.result.receipt
    expect(r.verification.verifierLocation).toBe('browser')
    expect(r.warnings.map((w) => w.code)).toContain('LOCAL_ONLY')
    expect(getLocalReceipt(r.identity.requestId)?.receipt).toEqual(r)
  })
})

