import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AllProvidersFailedError,
  ChainMismatchError,
  EngineUnreachableError,
  PRIVATE_NETWORKS,
  PrivacyUnavailableError,
  InternalError,
  InvalidProofError,
  InvalidRequestError,
  PolicyUnsatisfiableError,
  RootMismatchError,
  RootUnavailableError,
  VeriqSchemaError,
  TrustReceiptSchema,
  createPrivateReader,
  createVeriq,
  loadVerifier,
} from 'veriq-client'
import type { BrowserLightClient, BrowserRoot, BrowserVerifier, PrivateProvider, VerifyReadInput, VerifyReadOutcome } from 'veriq-client'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ADDRESS, type Handler, mockEngine, receiptFixture } from './helpers'

const ROOT = { number: 7412903, hash: `0x${'aa'.repeat(32)}`, stateRoot: `0x${'bb'.repeat(32)}`, rootSource: 'local-light-client', verified: true }
/** The next finalized block, for the moved-root tests. */
const ROOT2 = { ...ROOT, number: ROOT.number + 32, hash: `0x${'a2'.repeat(32)}` }
const PROOF = { accountProof: ['0x01'], balance: '0x1', nonce: '0x1', codeHash: `0x${'cc'.repeat(32)}`, storageHash: `0x${'dd'.repeat(32)}`, storageProof: [] }
const KEY = 'SuperSecretApiKey123456'
const ENGINE_URL = 'http://127.0.0.1:8547'
const A: PrivateProvider = { label: 'alpha', url: `https://alpha.example/v3/${KEY}` }
const B: PrivateProvider = { label: 'beta', url: 'https://beta.example/rpc' }
const asNumber = (root: { number: number }) => `0x${root.number.toString(16)}`

const anonReceipt = (label = 'alpha', status: 'verified' | 'unverified' = 'verified') =>
  receiptFixture({
    verification: { ...receiptFixture().verification, status },
    privacy: { transport: 'anon-rpc', mechanism: 'nox' },
    routing: { comparison: 'not-run', providersTried: 1, providerLabel: `${label}@anon-rpc:nox`, attempts: [] },
  })

const rootMoved = { error: { code: -32602, message: 'proof was fetched for block 0x22; call veriq_getRoot and fetch again', data: { code: 'INVALID_REQUEST' } } }
const forged = { error: { code: -32010, message: 'account proof does not chain to pinned stateRoot', data: { code: 'INVALID_PROOF' } } }

function ok(input: Record<string, unknown>) {
  const value = input.kind === 'code' ? '0x6080' : input.kind === 'storage' ? '0x2a' : '0x1bc16d674ec80000'
  return { result: { value, receipt: anonReceipt(String(input.provider)) } }
}

type Verify = (input: Record<string, unknown>, n: number) => ReturnType<Handler>

/** Engine stand-in. getRoot answers `roots` in turn (the last one repeats); verifyProof answers `verify`. */
function engine(verify: Verify = (input) => ok(input), roots: Array<typeof ROOT & { chainId?: number }> = [ROOT]) {
  let verifies = 0
  let rootCalls = 0
  const handler: Handler = (method, params) => {
    if (method === 'veriq_getRoot') return { result: roots[Math.min(rootCalls++, roots.length - 1)] }
    if (method === 'veriq_verifyProof') return verify(params[0] as Record<string, unknown>, verifies++)
    return { error: { code: -32601, message: 'unknown' } }
  }
  return mockEngine(handler)
}

type ProviderAnswer = { result: unknown } | { error: { code: number; message: string } } | 'throw' | 'hang' | 'bad-id'
type ProviderCall = { url: string; method: string; params: unknown[]; body: string }

/** The fake Anon-RPC fetch: records { url, method, body } and answers per call. No network. */
function anonFetch(answer: (call: ProviderCall) => ProviderAnswer = happyProvider) {
  const calls: ProviderCall[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body)
    const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] }
    const call = { url, method: parsed.method, params: parsed.params, body }
    calls.push(call)
    const a = answer(call)
    if (a === 'throw') throw new TypeError(`Failed to fetch ${url}`)
    if (a === 'hang') {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const id = a === 'bad-id' ? parsed.id + 1000 : parsed.id
    const payload = a === 'bad-id' ? { result: PROOF } : a
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }), { status: 200 })
  }
  return { fetch, calls }
}

function happyProvider(call: ProviderCall): ProviderAnswer {
  return { result: call.method === 'eth_getCode' ? '0x6080' : PROOF }
}

function reader(e: ReturnType<typeof mockEngine>, p: ReturnType<typeof anonFetch>, providers = [A, B], timeoutMs?: number) {
  const client = createVeriq({ url: ENGINE_URL, fetch: e.fetch })
  return createPrivateReader(client, { fetch: p.fetch, network: 'nox', providers, ...(timeoutMs ? { timeoutMs } : {}) })
}

const verifyCalls = (e: ReturnType<typeof mockEngine>) => e.calls.filter((c) => c.method === 'veriq_verifyProof')
const verifyInputs = (e: ReturnType<typeof mockEngine>) => verifyCalls(e).map((c) => c.params[0] as Record<string, unknown>)
const getRootCalls = (e: ReturnType<typeof mockEngine>) => e.calls.filter((c) => c.method === 'veriq_getRoot')

afterEach(() => {
  vi.useRealTimers()
})

describe('client.getRoot / client.verifyProof', () => {
  const input = { kind: 'balance' as const, address: ADDRESS, blockHash: ROOT.hash, proof: PROOF, provider: 'alpha', network: 'nox' }

  it('getRoot returns the validated RootInfo', async () => {
    await expect(createVeriq({ fetch: engine().fetch }).getRoot()).resolves.toEqual(ROOT)
  })

  it('getRoot with a missing stateRoot or a short hash is a schema error', async () => {
    const noState: Partial<typeof ROOT> = { ...ROOT }
    delete noState.stateRoot
    await expect(createVeriq({ fetch: mockEngine(() => ({ result: noState })).fetch }).getRoot()).rejects.toBeInstanceOf(VeriqSchemaError)
    const short = mockEngine(() => ({ result: { ...ROOT, hash: '0x1234' } }))
    await expect(createVeriq({ fetch: short.fetch }).getRoot()).rejects.toBeInstanceOf(VeriqSchemaError)
  })

  it('an engine error becomes a typed VeriqError', async () => {
    const noRoot = mockEngine(() => ({ error: { code: -32011, message: 'no finalized root', data: { code: 'ROOT_UNAVAILABLE' } } }))
    await expect(createVeriq({ fetch: noRoot.fetch }).getRoot()).rejects.toBeInstanceOf(RootUnavailableError)
    await expect(createVeriq({ fetch: engine(() => forged).fetch }).verifyProof(input)).rejects.toBeInstanceOf(InvalidProofError)
  })

  it('verifyProof surfaces verified: false from the receipt', async () => {
    const e = engine(() => ({ result: { value: '0x1', receipt: anonReceipt('alpha', 'unverified') } }))
    const r = await createVeriq({ fetch: e.fetch }).verifyProof(input)
    expect(r.verified).toBe(false)
    expect(r.receipt.privacy.transport).toBe('anon-rpc')
  })

  it('verifyProof never changes its input, sends slot only for storage and elapsedMs only when given', async () => {
    const e = engine()
    const client = createVeriq({ fetch: e.fetch })
    const frozen = Object.freeze({ ...input, slot: '0x0' })
    await client.verifyProof(frozen)
    expect(verifyInputs(e)[0]).not.toHaveProperty('slot')
    expect(verifyInputs(e)[0]).not.toHaveProperty('elapsedMs')
    expect(frozen.slot).toBe('0x0')

    await client.verifyProof({ ...frozen, kind: 'storage', elapsedMs: 12 })
    expect(verifyInputs(e)[1]).toMatchObject({ slot: '0x0', elapsedMs: 12 })
  })

  it('verifyProof checks address and slot before any request', async () => {
    const e = engine()
    const client = createVeriq({ fetch: e.fetch })
    await expect(client.verifyProof({ ...input, address: '0x12' })).rejects.toBeInstanceOf(InvalidRequestError)
    await expect(client.verifyProof({ ...input, kind: 'storage' })).rejects.toBeInstanceOf(InvalidRequestError)
    expect(e.calls).toHaveLength(0)
  })
})

describe('createPrivateReader', () => {
  it('balance: eth_getProof with no slots at the pinned block, bigint value', async () => {
    const e = engine()
    const p = anonFetch()
    const r = await reader(e, p).readBalance({ address: ADDRESS })
    expect(r.value).toBe(2_000_000_000_000_000_000n)
    expect(r.verified).toBe(true)
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0]).toMatchObject({ url: A.url, method: 'eth_getProof', params: [ADDRESS, [], { blockHash: ROOT.hash }] })
    expect(verifyInputs(e)[0]).toMatchObject({ kind: 'balance', address: ADDRESS, blockHash: ROOT.hash, proof: PROOF, provider: 'alpha', network: 'nox' })
    expect(verifyInputs(e)[0]).not.toHaveProperty('slot')
  })

  it('storage: the slot goes to eth_getProof and the value comes back as a 32-byte word', async () => {
    const e = engine()
    const p = anonFetch()
    const r = await reader(e, p).readStorage({ address: ADDRESS, slot: '0x0' })
    expect(r.value).toBe(`0x${'0'.repeat(62)}2a`)
    expect(p.calls[0]!.params).toEqual([ADDRESS, ['0x0'], { blockHash: ROOT.hash }])
    expect(verifyInputs(e)[0]).toMatchObject({ kind: 'storage', slot: '0x0' })
  })

  it('nonce: a bigint', async () => {
    const r = await reader(engine(), anonFetch()).readNonce({ address: ADDRESS })
    expect(typeof r.value).toBe('bigint')
  })

  it('code: eth_getProof then eth_getCode, both at the pinned block hash; the code stays hex', async () => {
    const e = engine()
    const p = anonFetch()
    const r = await reader(e, p).readCode({ address: ADDRESS })
    expect(r.value).toBe('0x6080')
    expect(r.receipt.privacy).toEqual({ transport: 'anon-rpc', mechanism: 'nox' })
    expect(p.calls.map((c) => [c.method, c.params])).toEqual([
      ['eth_getProof', [ADDRESS, [], { blockHash: ROOT.hash }]],
      ['eth_getCode', [ADDRESS, { blockHash: ROOT.hash }]],
    ])
    expect(verifyInputs(e)[0]).toMatchObject({ kind: 'code', code: '0x6080' })
  })

  it('provider 1 transport error: provider 2 answers', async () => {
    const p = anonFetch((call) => (call.url === A.url ? 'throw' : happyProvider(call)))
    const r = await reader(engine(), p).readBalance({ address: ADDRESS })
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
    expect(p.calls.map((c) => c.url)).toEqual([A.url, B.url])
  })

  it('provider 1 invalid proof: provider 2 answers', async () => {
    const e = engine((input) => (input.provider === 'alpha' ? forged : ok(input)))
    const r = await reader(e, anonFetch()).readBalance({ address: ADDRESS })
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
    expect(verifyInputs(e).map((i) => i.provider)).toEqual(['alpha', 'beta'])
  })

  it('a wrong JSON-RPC id from provider 1: provider 2 answers', async () => {
    const p = anonFetch((call) => (call.url === A.url ? 'bad-id' : happyProvider(call)))
    const r = await reader(engine(), p).readBalance({ address: ADDRESS })
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
  })

  it('provider 1 -32602 on blockHash: the same provider is asked by number, and that is remembered', async () => {
    const p = anonFetch((call) =>
      typeof call.params.at(-1) === 'object'
        ? { error: { code: -32602, message: 'invalid argument 2: hex string without 0x prefix' } }
        : happyProvider(call),
    )
    const e = engine()
    const r = reader(e, p)
    await r.readCode({ address: ADDRESS })
    expect(p.calls.map((c) => [c.url, c.method, c.params.at(-1)])).toEqual([
      [A.url, 'eth_getProof', { blockHash: ROOT.hash }],
      [A.url, 'eth_getProof', asNumber(ROOT)],
      [A.url, 'eth_getCode', asNumber(ROOT)],
    ])
    // Still verified at the engine's block: the hash goes to the engine, whatever form the provider took.
    expect(verifyInputs(e)[0]!.blockHash).toBe(ROOT.hash)
    await r.readBalance({ address: ADDRESS })
    expect(p.calls.at(-1)!.params.at(-1)).toBe(asNumber(ROOT))
  })

  it('-32000 "unknown block": retried by number, not remembered', async () => {
    let first = true
    const p = anonFetch((call) => {
      if (first && typeof call.params.at(-1) === 'object') {
        first = false
        return { error: { code: -32000, message: 'unknown block' } }
      }
      return happyProvider(call)
    })
    const r = reader(engine(), p)
    await r.readBalance({ address: ADDRESS })
    await r.readBalance({ address: ADDRESS })
    expect(p.calls.map((c) => c.params.at(-1))).toEqual([{ blockHash: ROOT.hash }, asNumber(ROOT), { blockHash: ROOT.hash }])
  })

  it('moved root: the root is fetched again and the same provider retried at the new block', async () => {
    const e = engine((input, n) => (n === 0 ? rootMoved : ok(input)), [ROOT, ROOT2])
    const p = anonFetch()
    const r = await reader(e, p).readBalance({ address: ADDRESS })
    expect(r.receipt.routing.providerLabel).toBe('alpha@anon-rpc:nox')
    expect(getRootCalls(e)).toHaveLength(2)
    expect(p.calls.map((c) => [c.url, c.params.at(-1)])).toEqual([
      [A.url, { blockHash: ROOT.hash }],
      [A.url, { blockHash: ROOT2.hash }],
    ])
    expect(verifyInputs(e).map((i) => [i.provider, i.blockHash])).toEqual([
      ['alpha', ROOT.hash],
      ['alpha', ROOT2.hash],
    ])
  })

  it('a root that moves every time: one retry, then a clear error and no other provider', async () => {
    const e = engine(() => rootMoved, [ROOT, ROOT2])
    const p = anonFetch()
    const err = await reader(e, p).readBalance({ address: ADDRESS }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(InvalidRequestError)
    expect((err as Error).message).toMatch(/moved again/)
    expect((err as Error).message).not.toMatch(/veriq_getRoot/) // not a hint to loop on
    expect(verifyCalls(e)).toHaveLength(2)
    expect(p.calls.every((c) => c.url === A.url)).toBe(true)
  })

  it('every blockHash sent is the one getRoot() returned', async () => {
    const e = engine(undefined, [ROOT2])
    const p = anonFetch()
    await reader(e, p).readCode({ address: ADDRESS })
    for (const call of p.calls) expect(call.params.at(-1)).toEqual({ blockHash: ROOT2.hash })
    expect(verifyInputs(e)[0]!.blockHash).toBe(ROOT2.hash)
  })

  it('all providers fail: AllProvidersFailedError with a hint and no URL or key', async () => {
    // alpha: the fetch fails, naming its URL. beta (last, so it is reported): a long upstream
    // message quoting alpha's URL, its key and another URL.
    const p = anonFetch((call) =>
      call.url === A.url
        ? 'throw'
        : { error: { code: -32603, message: `upstream ${A.url} rejected key ${KEY}; see https://docs.example/x ${'x'.repeat(500)}` } },
    )
    const err = await reader(engine(), p).readBalance({ address: ADDRESS }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(AllProvidersFailedError)
    expect((err as AllProvidersFailedError).hint).toMatch(/CORS/)
    const text = `${(err as Error).message} ${JSON.stringify(err)}`
    for (const secret of [KEY, 'alpha.example', 'beta.example', 'docs.example']) expect(text).not.toContain(secret)
    expect((err as Error).message.length).toBeLessThan(400)
  })

  it('only provider URLs go through the anonymizing fetch, and no provider URL reaches the engine', async () => {
    const e = engine((input) => (input.provider === 'alpha' ? forged : ok(input)))
    const p = anonFetch()
    const r = reader(e, p)
    await r.readCode({ address: ADDRESS })
    await r.readStorage({ address: ADDRESS, slot: '0x1' })
    expect(new Set(p.calls.map((c) => c.url))).toEqual(new Set([A.url, B.url]))
    expect(p.calls.some((c) => c.url.startsWith(ENGINE_URL))).toBe(false)
    const toEngine = JSON.stringify(e.calls)
    for (const secret of [A.url, B.url, KEY, 'alpha.example', 'beta.example']) expect(toEngine).not.toContain(secret)
    expect(e.mock.mock.calls.every(([url]) => String(url).startsWith(ENGINE_URL))).toBe(true)
  })

  it('a provider that does not answer in time is aborted and the next one is used (fake timers)', async () => {
    vi.useFakeTimers()
    const p = anonFetch((call) => (call.url === A.url ? 'hang' : happyProvider(call)))
    const pending = reader(engine(), p, [A, B], 30_000).readBalance({ address: ADDRESS })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(p.calls.map((c) => c.url)).toEqual([A.url])
    await vi.advanceTimersByTimeAsync(1)
    const r = await pending
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
  })

  it('engine, policy and root errors stop the read: no other provider is tried', async () => {
    const policyError = { error: { code: -32014, message: 'cannot satisfy', data: { code: 'POLICY_UNSATISFIABLE' } } }
    const e = engine(() => policyError)
    await expect(reader(e, anonFetch()).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(PolicyUnsatisfiableError)
    expect(verifyCalls(e)).toHaveLength(1)

    const noRoot = mockEngine(() => ({ error: { code: -32011, message: 'no finalized root', data: { code: 'ROOT_UNAVAILABLE' } } }))
    const p = anonFetch()
    await expect(reader(noRoot, p).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(RootUnavailableError)
    expect(p.calls).toHaveLength(0)
  })

  it('validates providers and network up front', () => {
    const client = createVeriq({ fetch: engine().fetch })
    const make = (providers: PrivateProvider[], extra: { network?: string; allowInsecureLoopback?: boolean } = {}) => () =>
      createPrivateReader(client, { fetch: anonFetch().fetch, network: extra.network ?? 'nox', providers, ...extra })

    expect(make([])).toThrow(InvalidRequestError)
    expect(make([A, { ...B, label: 'alpha' }])).toThrow(/used twice/)
    expect(make([{ label: 'plain', url: 'http://rpc.example' }])).toThrow(/https/)
    expect(make([{ label: 'local', url: 'http://127.0.0.1:8545' }])).toThrow(/https/)
    expect(make([{ label: 'local', url: 'http://127.0.0.1:8545' }], { allowInsecureLoopback: true })).not.toThrow()
    expect(make([{ label: 'remote', url: 'http://rpc.example' }], { allowInsecureLoopback: true })).toThrow(/https/)
    expect(make([A], { network: 'no spaces' })).toThrow(/network/)
    expect(make([{ label: 'not-a-url', url: 'nope' }])).toThrow(/valid URL/)

    // A URL pasted as a label is refused without being echoed.
    let message = ''
    try {
      make([{ label: A.url, url: A.url }])()
    } catch (x) {
      message = (x as Error).message
    }
    expect(message).toMatch(/label/)
    expect(message).not.toContain(KEY)
  })
})

describe('S4.2: root from a light client in the browser', () => {
  const browserOf = (root: typeof ROOT): BrowserRoot => ({ number: root.number, hash: root.hash, stateRoot: root.stateRoot })
  /** A browser light client that answers `roots` in turn (the last one repeats). */
  function lightClient(...roots: (BrowserRoot | null | 'throw')[]) {
    let calls = 0
    const lc: BrowserLightClient = {
      finalized: async () => {
        const r = roots[Math.min(calls++, roots.length - 1)]
        if (r === 'throw') throw new Error('helios: not synced')
        return r ?? null
      },
    }
    return { lc, calls: () => calls }
  }
  function withLightClient(e: ReturnType<typeof mockEngine>, p: ReturnType<typeof anonFetch>, lc: BrowserLightClient, alignTimeoutMs?: number) {
    const client = createVeriq({ url: ENGINE_URL, fetch: e.fetch })
    return createPrivateReader(client, { fetch: p.fetch, network: 'nox', providers: [A, B], lightClient: lc, ...(alignTimeoutMs ? { alignTimeoutMs } : {}) })
  }

  it('equal roots: the read is fetched at that block and the browser root is sent to the engine', async () => {
    const e = engine()
    const p = anonFetch()
    const r = await withLightClient(e, p, lightClient(browserOf(ROOT)).lc).readBalance({ address: ADDRESS })
    expect(r.value).toBe(2_000_000_000_000_000_000n)
    expect(verifyInputs(e)[0]).toMatchObject({ blockHash: ROOT.hash, browserRoot: browserOf(ROOT) })
    expect(p.calls[0]?.params.at(-1)).toEqual({ blockHash: ROOT.hash })
  })

  it('hash case does not matter', async () => {
    const e = engine()
    const upper = { ...browserOf(ROOT), hash: ROOT.hash.toUpperCase().replace('0X', '0x') }
    await expect(withLightClient(e, anonFetch(), lightClient(upper).lc).readBalance({ address: ADDRESS })).resolves.toBeDefined()
  })

  it('same block, different state root: ROOT_MISMATCH, no provider asked, nothing verified', async () => {
    const e = engine()
    const p = anonFetch()
    const lying = { ...browserOf(ROOT), stateRoot: `0x${'ee'.repeat(32)}` }
    const err = await withLightClient(e, p, lightClient(lying).lc).readBalance({ address: ADDRESS }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(RootMismatchError)
    expect((err as RootMismatchError).codeName).toBe('ROOT_MISMATCH')
    expect((err as Error).message).toContain(`#${ROOT.number}`)
    expect(p.calls).toHaveLength(0)
    expect(verifyCalls(e)).toHaveLength(0)
  })

  it('same block, different hash: ROOT_MISMATCH', async () => {
    const e = engine()
    const other = { ...browserOf(ROOT), hash: `0x${'ab'.repeat(32)}` }
    await expect(withLightClient(e, anonFetch(), lightClient(other).lc).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(RootMismatchError)
  })

  it('the browser is one epoch ahead: wait for the engine to reach the same block, then read', async () => {
    vi.useFakeTimers()
    const e = engine(undefined, [ROOT, ROOT, ROOT2])
    const p = anonFetch()
    const pending = withLightClient(e, p, lightClient(browserOf(ROOT2)).lc).readBalance({ address: ADDRESS })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBeDefined()
    expect(getRootCalls(e)).toHaveLength(3)
    expect(verifyInputs(e)[0]).toMatchObject({ blockHash: ROOT2.hash, browserRoot: browserOf(ROOT2) })
  })

  it('the two never meet: a bounded ROOT_UNAVAILABLE, no provider asked', async () => {
    vi.useFakeTimers()
    const e = engine()
    const p = anonFetch()
    const pending = withLightClient(e, p, lightClient(browserOf(ROOT2)).lc, 6_000).readBalance({ address: ADDRESS }).catch((x: unknown) => x)
    await vi.advanceTimersByTimeAsync(10_000)
    const err = await pending
    expect(err).toBeInstanceOf(RootUnavailableError)
    expect((err as Error).message).toContain('did not agree')
    expect(getRootCalls(e).length).toBeLessThanOrEqual(6)
    expect(p.calls).toHaveLength(0)
  })

  it('not synced (null), failed (throws) or malformed: the engine root is used alone, no browserRoot sent', async () => {
    for (const answer of [null, 'throw' as const, { number: 1.5, hash: '0x1', stateRoot: '0x2' }]) {
      const e = engine()
      await withLightClient(e, anonFetch(), lightClient(answer as BrowserRoot | null | 'throw').lc).readBalance({ address: ADDRESS })
      expect(verifyInputs(e)[0]).not.toHaveProperty('browserRoot')
      expect(verifyInputs(e)[0]).toMatchObject({ blockHash: ROOT.hash })
    }
  })

  it('an engine ROOT_MISMATCH (defence in depth) is not retried on another provider', async () => {
    const e = engine(() => ({ error: { code: -32017, message: 'roots differ', data: { code: 'ROOT_MISMATCH' } } }))
    const p = anonFetch()
    await expect(withLightClient(e, p, lightClient(browserOf(ROOT)).lc).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(RootMismatchError)
    expect(verifyCalls(e)).toHaveLength(1)
    expect(new Set(p.calls.map((c) => c.url))).toEqual(new Set([A.url]))
  })

  it('a moved root re-pins both light clients before fetching again', async () => {
    const e = engine((input, n) => (n === 0 ? rootMoved : ok(input)), [ROOT, ROOT2])
    const lc = lightClient(browserOf(ROOT), browserOf(ROOT2))
    const r = await withLightClient(e, anonFetch(), lc.lc).readBalance({ address: ADDRESS })
    expect(r.value).toBe(2_000_000_000_000_000_000n)
    expect(lc.calls()).toBe(2)
    expect(verifyInputs(e)[1]).toMatchObject({ blockHash: ROOT2.hash, browserRoot: browserOf(ROOT2) })
  })
})

describe('S5: proofs checked in the browser first', () => {
  const browserOf = (root: typeof ROOT): BrowserRoot => ({ number: root.number, hash: root.hash, stateRoot: root.stateRoot })
  const synced = (root: BrowserRoot | null = browserOf(ROOT)): BrowserLightClient => ({ finalized: async () => root })
  const honest = (input: VerifyReadInput): VerifyReadOutcome => ({
    ok: true,
    value: input.kind === 'code' ? '0x6080' : input.kind === 'storage' ? '0x2a' : '0x1bc16d674ec80000',
  })
  function fakeVerifier(answer: (input: VerifyReadInput, n: number) => VerifyReadOutcome = honest) {
    const inputs: VerifyReadInput[] = []
    const verifier: BrowserVerifier = {
      abiVersion: 2,
      verifyRead: (input) => answer(input, inputs.push(input) - 1),
      binding: () => 'ab'.repeat(32),
    }
    return { verifier, inputs }
  }
  /** An engine that is not there: every request fails like a closed port. */
  const deadEngine = () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    return { fetch: fetch as unknown as typeof globalThis.fetch, fetchMock: fetch }
  }
  function make(engineFetch: typeof globalThis.fetch, p: ReturnType<typeof anonFetch>, extra: Partial<Parameters<typeof createPrivateReader>[1]> = {}) {
    return createPrivateReader(createVeriq({ url: ENGINE_URL, fetch: engineFetch }), { fetch: p.fetch, network: 'nox', providers: [A, B], ...extra })
  }

  it('a valid proof is checked in the browser against the pinned root, then by the engine, marked browser', async () => {
    const e = engine()
    const v = fakeVerifier()
    const r = await make(e.fetch, anonFetch(), { verifier: v.verifier }).readBalance({ address: ADDRESS })
    expect(r.value).toBe(2_000_000_000_000_000_000n)
    expect(v.inputs[0]).toMatchObject({ stateRoot: ROOT.stateRoot, address: ADDRESS, kind: 'balance', proof: PROOF })
    expect(verifyInputs(e)[0]).toMatchObject({ verifier: 'browser' })
  })

  it('a forged proof is rejected in the browser and never reaches the engine; the next provider is asked', async () => {
    const e = engine()
    const v = fakeVerifier((input, n) => (n === 0 ? { ok: false, code: 'INVALID_PROOF', error: 'claimed account does not match proven account' } : honest(input)))
    const p = anonFetch()
    const r = await make(e.fetch, p, { verifier: v.verifier }).readBalance({ address: ADDRESS })
    expect(verifyCalls(e)).toHaveLength(1)
    expect(verifyInputs(e)[0]).toMatchObject({ provider: 'beta', verifier: 'browser' })
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
  })

  it('every provider forged: InvalidProofError, the engine was never asked to verify', async () => {
    const e = engine()
    const v = fakeVerifier(() => ({ ok: false, code: 'INVALID_PROOF', error: 'account proof: root mismatch' }))
    const err = await make(e.fetch, anonFetch(), { verifier: v.verifier }).readBalance({ address: ADDRESS }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(InvalidProofError)
    expect((err as Error).message).toMatch(/rejected in the browser/)
    expect(verifyCalls(e)).toHaveLength(0)
  })

  it('the verifier does not load: loaded once, the engine verifies and is told (BROWSER_VERIFIER_UNAVAILABLE)', async () => {
    const e = engine()
    const load = vi.fn(async (): Promise<BrowserVerifier> => {
      throw new Error('HTTP 404')
    })
    const reader = make(e.fetch, anonFetch(), { verifier: load })
    await reader.readBalance({ address: ADDRESS })
    await reader.readNonce({ address: ADDRESS })
    expect(load).toHaveBeenCalledTimes(1)
    expect(verifyInputs(e).map((i) => i.verifier)).toEqual(['unavailable', 'unavailable'])
  })

  it('engine unreachable, browser light client synced, verifier loaded: a local-only, browser-made receipt', async () => {
    const dead = deadEngine()
    const v = fakeVerifier()
    const p = anonFetch()
    const r = await make(dead.fetch, p, { verifier: v.verifier, lightClient: synced() }).readStorage({ address: ADDRESS, slot: '0x0' })
    expect(r.value).toBe(`0x${'0'.repeat(62)}2a`)
    expect(r.verified).toBe(true)
    expect(() => TrustReceiptSchema.parse(r.receipt)).not.toThrow()
    expect(r.receipt.verification).toMatchObject({ status: 'verified', verifierLocation: 'browser', rootSource: 'local-light-client', mechanisms: ['account-proof', 'storage-proof'] })
    expect(r.receipt.identity.requestId).toMatch(/^local-/)
    expect(r.receipt.block).toEqual({ number: ROOT.number, hash: ROOT.hash, stateRoot: ROOT.stateRoot, finalized: true })
    expect(r.receipt.privacy).toEqual({ transport: 'anon-rpc', mechanism: 'nox' })
    expect(r.receipt.warnings.map((w) => w.code)).toEqual(['LOCAL_ONLY', 'BROWSER_LIGHT_CLIENT'])
    expect(r.attempts).toEqual([expect.objectContaining({ provider: 'alpha@anon-rpc:nox', outcome: 'ok' })])
    // The provider was asked at the browser light client's block.
    expect(p.calls[0]?.params.at(-1)).toEqual({ blockHash: ROOT.hash })
  })

  it('engine reachable for getRoot but gone for verifyProof: still answered locally', async () => {
    let calls = 0
    const e = engine()
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (calls++ > 0) throw new TypeError('Failed to fetch')
      return e.fetch(input, init)
    }) as typeof globalThis.fetch
    const r = await make(flaky, anonFetch(), { verifier: fakeVerifier().verifier, lightClient: synced() }).readBalance({ address: ADDRESS })
    expect(r.receipt.warnings[0]?.code).toBe('LOCAL_ONLY')
  })

  it('engine unreachable without a synced browser light client, or without the verifier: EngineUnreachableError', async () => {
    const p = anonFetch()
    await expect(make(deadEngine().fetch, p, { verifier: fakeVerifier().verifier }).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(EngineUnreachableError)
    await expect(make(deadEngine().fetch, p, { verifier: fakeVerifier().verifier, lightClient: synced(null) }).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(EngineUnreachableError)
    const broken = async (): Promise<BrowserVerifier> => {
      throw new Error('no wasm')
    }
    await expect(make(deadEngine().fetch, p, { verifier: broken, lightClient: synced() }).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(EngineUnreachableError)
    expect(p.calls).toHaveLength(0) // nothing fetched that could not be verified
  })

  it('browser and engine proving different values from one proof: InternalError, no value', async () => {
    const e = engine((input) => ({ result: { value: '0x1', receipt: anonReceipt(String(input.provider)) } }))
    await expect(make(e.fetch, anonFetch(), { verifier: fakeVerifier().verifier }).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(InternalError)
  })

  describe('with the real .wasm and a real Sepolia proof (fixtures/demo-storage.json)', () => {
    const demo = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/demo-storage.json', import.meta.url)), 'utf8')) as {
      address: string
      block: { number: number; hash: string; stateRoot: string }
      proof: { storageProof: { value: string }[] }
    }
    const wasm = () => loadVerifier(readFileSync(fileURLToPath(new URL('../wasm/veriq_verifier.wasm', import.meta.url))))
    const lc = synced({ number: demo.block.number, hash: demo.block.hash, stateRoot: demo.block.stateRoot })

    it('no engine at all: slot 0 = 42, verified in the browser, receipt bindings from the Rust code', async () => {
      const p = anonFetch(() => ({ result: demo.proof }))
      const r = await make(deadEngine().fetch, p, { verifier: wasm, lightClient: lc }).readStorage({ address: demo.address, slot: '0x0' })
      expect(BigInt(r.value)).toBe(42n)
      expect(r.receipt.verification.verifierLocation).toBe('browser')
      expect(r.receipt.identity.resultBinding).toMatch(/^[0-9a-f]{64}$/)
    })

    it('a provider that lies about slot 0 is caught in the browser', async () => {
      const lie = JSON.parse(JSON.stringify(demo.proof)) as typeof demo.proof
      lie.storageProof[0]!.value = '0x2b'
      const p = anonFetch(() => ({ result: lie }))
      await expect(make(deadEngine().fetch, p, { verifier: wasm, lightClient: lc }).readStorage({ address: demo.address, slot: '0x0' })).rejects.toBeInstanceOf(InvalidProofError)
    })
  })
})

describe('S6: the private network follows the chain', () => {
  const reader = (network: string, chainId: number, roots: Array<typeof ROOT & { chainId?: number }> = [ROOT], p = anonFetch()) =>
    createPrivateReader(createVeriq({ url: ENGINE_URL, fetch: engine(undefined, roots).fetch }), { fetch: p.fetch, network, providers: [A], chainId })

  it('Nox on Sepolia, Nym or Tor on mainnet', () => {
    expect(PRIVATE_NETWORKS).toEqual({ 1: ['nym', 'tor'], 11155111: ['nox'] })
    expect(() => reader('nox', 11155111)).not.toThrow()
    expect(() => reader('nym', 1)).not.toThrow()
    expect(() => reader('tor', 1)).not.toThrow()
  })

  it('a wrong network for the chain is PrivacyUnavailableError before anything is sent', () => {
    const p = anonFetch()
    let err: unknown
    try {
      reader('nox', 1, [ROOT], p)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PrivacyUnavailableError)
    expect((err as Error).message).toMatch(/"nox" does not carry chain 1; use "nym" or "tor"/)
    expect(() => reader('nym', 11155111)).toThrow(PrivacyUnavailableError)
    expect(() => reader('nox', 10)).toThrow(/no private network is known for chain 10/)
    expect(p.calls).toHaveLength(0)
  })

  it('an engine on another chain is ChainMismatchError; no provider is asked', async () => {
    const p = anonFetch()
    const mainnetReader = reader('nym', 1, [{ ...ROOT, chainId: 11155111 }], p)
    await expect(mainnetReader.readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(ChainMismatchError)
    // An engine from before S6 reports no chainId: it can only be Sepolia.
    await expect(reader('nym', 1, [ROOT], p).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(ChainMismatchError)
    expect(p.calls).toHaveLength(0)
  })

  it('the matching engine reads normally', async () => {
    const p = anonFetch()
    const r = await reader('nym', 1, [{ ...ROOT, chainId: 1 }], p).readBalance({ address: ADDRESS })
    expect(r.value).toBe(2_000_000_000_000_000_000n)
    expect(new Set(p.calls.map((c) => c.url))).toEqual(new Set([A.url]))
    await expect(reader('nox', 11155111, [ROOT]).readBalance({ address: ADDRESS })).resolves.toBeDefined()
  })
})
