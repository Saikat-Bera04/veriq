import { describe, expect, it } from 'vitest'
import { InvalidRequestError, PolicyUnsatisfiableError, TrustReceiptSchema, createVeriq, presets, verifiedFinalized } from 'veriq-client'
import { ADDRESS, ATTEMPTS, happyEngine, mockEngine, receiptFixture } from './helpers'

describe('createVeriq', () => {
  it('readBalance returns the proven bigint, receipt, verified flag and attempts', async () => {
    const { fetch, calls } = mockEngine(happyEngine)
    const r = await createVeriq({ fetch }).readBalance({ address: ADDRESS })
    expect(r.value).toBe(2_000_000_000_000_000_000n)
    expect(r.verified).toBe(true)
    expect(r.attempts).toEqual(ATTEMPTS)
    expect(calls[0]).toEqual({ method: 'veriq_readBalance', params: [ADDRESS, verifiedFinalized] })
  })

  it('readStorage returns a 32-byte 0x value', async () => {
    const { fetch } = mockEngine(happyEngine)
    const r = await createVeriq({ fetch }).readStorage({ address: ADDRESS, slot: '0x0' })
    expect(r.value).toBe(`0x${'0'.repeat(62)}2a`)
  })

  it.each([
    ['too short', '0x1234'],
    ['no prefix', 'd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
    ['non-hex', `0x${'g'.repeat(40)}`],
  ])('rejects a bad address (%s) before any fetch', async (_label, address) => {
    const { fetch, mock } = mockEngine(happyEngine)
    await expect(createVeriq({ fetch }).readBalance({ address })).rejects.toBeInstanceOf(InvalidRequestError)
    expect(mock).not.toHaveBeenCalled()
  })

  it.each([['empty', '0x'], ['too long', `0x${'1'.repeat(65)}`], ['no prefix', '00']])('rejects a bad slot (%s) before any fetch', async (_l, slot) => {
    const { fetch, mock } = mockEngine(happyEngine)
    await expect(createVeriq({ fetch }).readStorage({ address: ADDRESS, slot })).rejects.toBeInstanceOf(InvalidRequestError)
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects a malformed policy client-side', async () => {
    const { fetch, mock } = mockEngine(happyEngine)
    const policy = { ...verifiedFinalized, timeoutMs: -1 }
    await expect(createVeriq({ fetch }).readBalance({ address: ADDRESS, policy })).rejects.toThrow(/policy\.timeoutMs/)
    expect(mock).not.toHaveBeenCalled()
  })

  it('sends latest + required to the engine and surfaces PolicyUnsatisfiableError', async () => {
    const { fetch, calls } = mockEngine((_m, params) => {
      const p = params[1] as { blockPolicy: string; verification: string }
      return p.blockPolicy === 'latest' && p.verification === 'required'
        ? { error: { code: -32014, message: 'blockPolicy=latest cannot satisfy verification=required' } }
        : happyEngine('veriq_readBalance', params)
    })
    const policy = { ...verifiedFinalized, blockPolicy: 'latest' as const }
    await expect(createVeriq({ fetch }).readBalance({ address: ADDRESS, policy })).rejects.toBeInstanceOf(PolicyUnsatisfiableError)
    expect(calls).toHaveLength(1)
  })

  it('withPolicy returns a new immutable client', async () => {
    const { fetch, calls } = mockEngine(happyEngine)
    const a = createVeriq({ fetch })
    const b = a.withPolicy(presets.verifiedCompare)
    expect(b).not.toBe(a)
    expect(a.policy.consistency).toBe('single')
    expect(Object.isFrozen(a)).toBe(true)
    await b.readBalance({ address: ADDRESS })
    expect((calls[0]?.params[1] as { consistency: string }).consistency).toBe('compare')
  })

  it('getReceipt and health parse through the schema', async () => {
    const { fetch } = mockEngine(happyEngine)
    const veriq = createVeriq({ fetch })
    expect((await veriq.getReceipt('abc')).identity.requestId).toBe('abc')
    expect((await veriq.health()).lightClient.synced).toBe(true)
  })
})

describe('receipt attempts (receipt.rs routing.attempts)', () => {
  it('fills VerifiedResult.attempts from the receipt when the engine sends no separate list', async () => {
    const receipt = receiptFixture({
      routing: {
        comparison: 'not-run',
        providersTried: 2,
        providerLabel: 'honest',
        attempts: [
          { provider: 'attacker', outcome: 'invalid-proof', elapsedMs: 12, failureReason: 'INVALID_PROOF: bad node' },
          { provider: 'honest', outcome: 'success', elapsedMs: 9 },
        ],
      },
    })
    const { fetch } = mockEngine(() => ({ result: { value: '0x1', receipt } }))
    const r = await createVeriq({ fetch }).readBalance({ address: ADDRESS })
    expect(r.attempts).toEqual([
      { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 12, reason: 'INVALID_PROOF: bad node' },
      { provider: 'honest', outcome: 'ok', elapsedMs: 9 },
    ])
  })

  it('still parses older receipts without attempts', () => {
    const legacy = receiptFixture() as unknown as { routing: Record<string, unknown> }
    delete legacy.routing.attempts
    expect(TrustReceiptSchema.parse(legacy).routing.attempts).toEqual([])
  })
})

  describe('health() against the engine shape (backend/crates/server/src/http.rs)', () => {
  const flat = (body: unknown) => mockEngine(() => ({ result: null }), () => body)

  it('normalizes the synced flat shape', async () => {
    const { fetch } = flat({
      status: 'ok', synced: true, rootSource: 'local-light-client', finalizedNumber: 11996907,
      finalizedHash: `0x${'b'.repeat(64)}`, stateRoot: `0x${'c'.repeat(64)}`, lagSeconds: 0, providers: 2,
      bootstrap: { source: 'helios', checkpoint: '0x5e6d', checkpointSource: 'beaconcha.in' }, bind: '127.0.0.1:8547',
    })
    const h = await createVeriq({ fetch }).health()
    expect(h).toMatchObject({ ok: true, rootSource: 'local-light-client', providerCount: 2, providers: [], bind: '127.0.0.1:8547' })
    expect(h.lightClient).toMatchObject({ synced: true, finalizedNumber: 11996907, checkpointSource: 'beaconcha.in' })
  })

  it('keeps headNumber and lastUpdateUnix from the flat shape', async () => {
    const { fetch } = flat({
      status: 'ok', synced: true, rootSource: 'local-light-client', finalizedNumber: 100, headNumber: 164,
      lagSeconds: 4, lastUpdateUnix: 1_793_000_000, providers: 1,
    })
    const { lightClient } = await createVeriq({ fetch }).health()
    expect(lightClient).toMatchObject({ finalizedNumber: 100, headNumber: 164, lagSeconds: 4, lastUpdateUnix: 1_793_000_000 })
  })

  it('parses the nested shape, including a degraded refresh that still serves the last good root', async () => {
    const { fetch } = flat({
      status: 'degraded', ok: false, rootSource: 'local-light-client', devMode: false, providerCount: 0, providers: [],
      finalizedNumber: 100, headNumber: 164,
      lightClient: { available: true, synced: false, finalizedNumber: 100, headNumber: 164, lagSeconds: 20, lastUpdateUnix: 1_793_000_000 },
      rootCache: { ageSeconds: 20, consecutiveFailures: 2 },
      error: { code: 'ROOT_REFRESH_FAILING', message: 'light-client refresh failing; serving the last good finalized root (20s old)' },
    })
    const h = await createVeriq({ fetch }).health()
    expect(h).toMatchObject({ ok: false, rootSource: 'local-light-client', error: { code: 'ROOT_REFRESH_FAILING' } })
    expect(h.lightClient).toMatchObject({ synced: false, finalizedNumber: 100, headNumber: 164, lagSeconds: 20 })
  })

  it('normalizes the degraded shape (no root yet)', async () => {
    const { fetch } = flat({ status: 'degraded', synced: false, error: 'ROOT_UNAVAILABLE', message: 'not synced', providers: 1, bind: '127.0.0.1:8547' })
    const h = await createVeriq({ fetch }).health()
    expect(h).toMatchObject({ ok: false, rootSource: null, error: { code: 'ROOT_UNAVAILABLE' }, lightClient: { synced: false } })
  })
})

describe('stored receipts from the engine (crates/server/src/store.rs)', () => {
  it('normalizes RoutingAttempt rows so rejected and successful attempts display correctly', async () => {
    const row = {
      id: 'r1', createdAt: 1, method: 'veriq_readBalance', params: { address: ADDRESS }, value: '0x1', blockNumber: 7,
      receipt: receiptFixture(), error: null,
      attempts: [
        { provider: 'attacker', outcome: 'invalid-proof', elapsedMs: 5, failureReason: 'INVALID_PROOF: bad node' },
        { provider: 'honest', outcome: 'success', elapsedMs: 4 },
      ],
    }
    const { fetch } = mockEngine(() => ({ result: null }), () => ({ receipts: [row] }))
    const [r] = await createVeriq({ fetch }).listReceipts(1)
    expect(r?.attempts).toEqual([
      { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 5, reason: 'INVALID_PROOF: bad node' },
      { provider: 'honest', outcome: 'ok', elapsedMs: 4 },
    ])
  })
})
