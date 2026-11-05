import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HONEST_WEI, healthBody, receiptRow, RECEIPT, serve, verifiedRead } from '../test/services'

// engine.ts remembers whether the engine/attacker answered (module state), so each
// test gets a fresh copy.
beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
})
const load = () => import('./engine')

describe('live/mock fallback tagging', () => {
  it('tags everything "mock" when the engine is unreachable, and stops calling it', async () => {
    const calls = serve({}) // nothing answers
    const engine = await load()

    const health = await engine.fetchHealth()
    expect(health.source).toBe('mock')

    const receipts = await engine.fetchReceipts(10)
    expect(receipts.source).toBe('mock')
    expect(receipts.data.length).toBeGreaterThan(0)

    const read = await engine.readBalance('0x0000000000000000000000000000000000000000')
    expect(read.source).toBe('mock')
    // Once health said "offline", reads go straight to sample data.
    expect(calls.filter((c) => c.url === '/engine')).toHaveLength(0)
  })

  it('tags a reachable engine "live" and never mixes sample receipts into it', async () => {
    serve({ health: () => healthBody, engineRpc: () => verifiedRead() }) // no GET /receipts (404)
    const engine = await load()

    expect((await engine.fetchHealth()).source).toBe('live')
    const receipts = await engine.fetchReceipts(10)
    expect(receipts).toEqual({ source: 'live', data: [] })

    const read = await engine.readBalance('0x0000000000000000000000000000000000000000')
    expect(read.source).toBe('live')
    expect(read.ok && read.result.value).toBe(HONEST_WEI)
  })

  it('returns stored receipts from a live engine', async () => {
    serve({ health: () => healthBody, receipts: () => ({ receipts: [receiptRow] }) })
    const engine = await load()
    await engine.fetchHealth()
    const receipts = await engine.fetchReceipts(10)
    expect(receipts.source).toBe('live')
    expect(receipts.data.map((r) => r.id)).toEqual([receiptRow.id])
  })

  it('reads deployed contract storage through veriq_readStorage and returns a full-width value', async () => {
    const storageReceipt = {
      ...RECEIPT,
      identity: { ...RECEIPT.identity, method: 'veriq_readStorage' },
      verification: { ...RECEIPT.verification, mechanisms: ['account-proof', 'storage-proof'] },
    }
    const calls = serve({
      engineRpc: (method) =>
        method === 'veriq_readStorage'
          ? { result: { value: '0x2a', receipt: storageReceipt, attempts: [] } }
          : { error: { code: -32601, message: 'method not found' } },
    })
    const engine = await load()

    const read = await engine.readStorage()

    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.result.value).toBe(`0x${'0'.repeat(62)}2a`)
      expect(read.result.verified).toBe(true)
    }
    const request = calls.find((call) => call.url === '/engine')?.body as { method: string; params: unknown[] }
    expect(request.method).toBe('veriq_readStorage')
    expect(request.params.slice(0, 2)).toEqual([engine.DEMO_CONTRACT_ADDRESS, engine.DEMO_CONTRACT_SLOT])
    expect(request.params[2]).toMatchObject({ verification: 'required', blockPolicy: 'finalized' })
  })

  it('never substitutes mock state for a failed deployed contract storage read', async () => {
    const calls = serve({})
    const engine = await load()

    const read = await engine.readStorage()

    expect(read.ok).toBe(false)
    expect(calls.filter((call) => call.url === '/engine')).toHaveLength(1)
  })

  it('treats a typed engine error as live, not as "offline": no sample value is swapped in', async () => {
    serve({
      health: () => healthBody,
      engineRpc: () => ({ error: { code: -32014, message: 'strict mode only serves finalized reads', data: { code: 'POLICY_UNSATISFIABLE' } } }),
    })
    const engine = await load()
    // The same (freshly loaded) SDK copy engine.ts uses, so instanceof is meaningful.
    const { VeriqError } = await import('veriq-client')
    await engine.fetchHealth()
    const read = await engine.readBalance('0x0000000000000000000000000000000000000000')
    expect(read.ok).toBe(false)
    expect(read.source).toBe('live')
    if (!read.ok) {
      expect(read.error).toBeInstanceOf(VeriqError)
      expect((read.error as InstanceType<typeof VeriqError>).code).toBe(-32014)
      expect((read.error as InstanceType<typeof VeriqError>).codeName).toBe('POLICY_UNSATISFIABLE')
    }
  })

  it('keeps an engine error that mentions an HTTP status as a live error, not "engine offline"', async () => {
    // provider.rs reports upstream HTTP failures like this; the engine itself is up.
    serve({
      health: () => healthBody,
      engineRpc: () => ({
        error: { code: -32015, message: 'provider returned HTTP 503 Service Unavailable', data: { code: 'PROVIDER_TIMEOUT' } },
      }),
    })
    const engine = await load()
    await engine.fetchHealth()
    const read = await engine.readBalance('0x0000000000000000000000000000000000000000')
    expect(read).toMatchObject({ ok: false, source: 'live' })
  })

  it('simulates the attacker in the browser when it is not running', async () => {
    const calls = serve({})
    const engine = await load()
    const mode = await engine.fetchAttackerMode()
    expect(mode.source).toBe('mock')
    await engine.setAttackerMode('value')
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/attacker/mode')).toHaveLength(0)
    expect((await engine.fetchAttackerMode()).data).toBe('value')
  })

  it('does not replace an unavailable hosted attacker with browser-generated modes', async () => {
    vi.stubEnv('DEV', false)
    serve({})
    const engine = await load()

    await expect(engine.fetchAttackerMode()).rejects.toThrow(/protected attacker service configured/)
  })
})
