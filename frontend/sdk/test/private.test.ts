import { describe, expect, it } from 'vitest'
import {
  AllProvidersFailedError,
  InvalidProofError,
  InvalidRequestError,
  PolicyUnsatisfiableError,
  RootUnavailableError,
  VeriqSchemaError,
  createPrivateReader,
  createVeriq,
} from 'veriq-client'
import type { PrivateProvider } from 'veriq-client'
import { ADDRESS, type Handler, mockEngine, receiptFixture } from './helpers'

const HASH = `0x${'aa'.repeat(32)}`
const ROOT = { number: 7412903, hash: HASH, stateRoot: `0x${'bb'.repeat(32)}`, rootSource: 'local-light-client', verified: true }
const PROOF = { accountProof: ['0x01'], balance: '0x1', nonce: '0x1', codeHash: `0x${'cc'.repeat(32)}`, storageHash: `0x${'dd'.repeat(32)}`, storageProof: [] }
const KEY = 'SuperSecretApiKey123456'
const A: PrivateProvider = { label: 'alpha', url: `https://alpha.example/v3/${KEY}` }
const B: PrivateProvider = { label: 'beta', url: 'https://beta.example/rpc' }

const anonReceipt = (label = 'alpha', status: 'verified' | 'unverified' = 'verified') =>
  receiptFixture({
    verification: { ...receiptFixture().verification, status },
    privacy: { transport: 'anon-rpc', mechanism: 'nox' },
    routing: { comparison: 'not-run', providersTried: 1, providerLabel: `${label}@anon-rpc:nox`, attempts: [] },
  })

const rootMoved = { error: { code: -32602, message: 'proof was fetched for block 0x22; call veriq_getRoot and fetch again', data: { code: 'INVALID_REQUEST' } } }
const forged = { error: { code: -32010, message: 'account proof does not chain to pinned stateRoot', data: { code: 'INVALID_PROOF' } } }

/** Engine stand-in: getRoot answers ROOT; verifyProof answers `verify` (default: success). */
function engine(verify: (input: Record<string, unknown>, n: number) => ReturnType<Handler> = (input) => ok(input)) {
  let n = 0
  const handler: Handler = (method, params) => {
    if (method === 'veriq_getRoot') return { result: ROOT }
    if (method === 'veriq_verifyProof') return verify(params[0] as Record<string, unknown>, n++)
    return { error: { code: -32601, message: 'unknown' } }
  }
  return mockEngine(handler)
}

function ok(input: Record<string, unknown>) {
  const value = input.kind === 'code' ? '0x6080' : input.kind === 'storage' ? '0x2a' : '0x1bc16d674ec80000'
  return { result: { value, receipt: anonReceipt(String(input.provider)) } }
}

type ProviderAnswer = { result: unknown } | { error: { code: number; message: string } } | 'throw' | 'hang' | 'bad-id'
type ProviderCall = { url: string; method: string; params: unknown[] }

/** The anonymizing fetch, answering per provider URL. */
function anonFetch(answer: (call: ProviderCall) => ProviderAnswer) {
  const calls: ProviderCall[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
    const call = { url, method: body.method, params: body.params }
    calls.push(call)
    const a = answer(call)
    if (a === 'throw') throw new TypeError(`Failed to fetch ${url}`)
    if (a === 'hang') {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const id = a === 'bad-id' ? body.id + 1000 : body.id
    const payload = a === 'bad-id' ? { result: PROOF } : a
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...payload }), { status: 200 })
  }
  return { fetch, calls }
}

const happyProvider = (call: ProviderCall): ProviderAnswer => ({ result: call.method === 'eth_getCode' ? '0x6080' : PROOF })

function reader(engineMock: ReturnType<typeof mockEngine>, provider: ReturnType<typeof anonFetch>, providers = [A, B]) {
  return createPrivateReader(createVeriq({ fetch: engineMock.fetch }), { fetch: provider.fetch, network: 'nox', providers })
}

const verifyCalls = (e: ReturnType<typeof mockEngine>) => e.calls.filter((c) => c.method === 'veriq_verifyProof')

describe('client.getRoot / client.verifyProof', () => {
  it('getRoot returns the validated RootInfo', async () => {
    const e = engine()
    await expect(createVeriq({ fetch: e.fetch }).getRoot()).resolves.toEqual(ROOT)
  })

  it('getRoot with a missing stateRoot is a schema error', async () => {
    const noState: Partial<typeof ROOT> = { ...ROOT }
    delete noState.stateRoot
    const e = mockEngine(() => ({ result: noState }))
    await expect(createVeriq({ fetch: e.fetch }).getRoot()).rejects.toBeInstanceOf(VeriqSchemaError)
  })

  it('getRoot with a short hash is a schema error', async () => {
    const e = mockEngine(() => ({ result: { ...ROOT, hash: '0x1234' } }))
    await expect(createVeriq({ fetch: e.fetch }).getRoot()).rejects.toBeInstanceOf(VeriqSchemaError)
  })

  it('an engine error becomes a typed VeriqError', async () => {
    const e = mockEngine(() => ({ error: { code: -32011, message: 'no finalized root', data: { code: 'ROOT_UNAVAILABLE' } } }))
    await expect(createVeriq({ fetch: e.fetch }).getRoot()).rejects.toBeInstanceOf(RootUnavailableError)
    const f = engine(() => forged)
    const input = { kind: 'balance' as const, address: ADDRESS, blockHash: HASH, proof: PROOF, provider: 'alpha', network: 'nox' }
    await expect(createVeriq({ fetch: f.fetch }).verifyProof(input)).rejects.toBeInstanceOf(InvalidProofError)
  })

  it('verifyProof surfaces verified: false from the receipt', async () => {
    const e = engine(() => ({ result: { value: '0x1', receipt: anonReceipt('alpha', 'unverified') } }))
    const input = { kind: 'balance' as const, address: ADDRESS, blockHash: HASH, proof: PROOF, provider: 'alpha', network: 'nox' }
    const r = await createVeriq({ fetch: e.fetch }).verifyProof(input)
    expect(r.verified).toBe(false)
    expect(r.receipt.privacy.transport).toBe('anon-rpc')
  })

  it('verifyProof never changes its input, sends slot only for storage and elapsedMs only when given', async () => {
    const e = engine()
    const client = createVeriq({ fetch: e.fetch })
    const input = Object.freeze({ kind: 'balance' as const, address: ADDRESS, slot: '0x0', blockHash: HASH, proof: PROOF, provider: 'alpha', network: 'nox' })
    await client.verifyProof(input)
    const sent = verifyCalls(e)[0]!.params[0] as Record<string, unknown>
    expect(sent).not.toHaveProperty('slot')
    expect(sent).not.toHaveProperty('elapsedMs')
    expect(input.slot).toBe('0x0')

    await client.verifyProof({ ...input, kind: 'storage', elapsedMs: 12 })
    expect(verifyCalls(e)[1]!.params[0]).toMatchObject({ slot: '0x0', elapsedMs: 12 })
  })

  it('verifyProof checks address and slot before any request', async () => {
    const e = engine()
    const client = createVeriq({ fetch: e.fetch })
    const base = { blockHash: HASH, proof: PROOF, provider: 'alpha', network: 'nox' }
    await expect(client.verifyProof({ ...base, kind: 'balance', address: '0x12' })).rejects.toBeInstanceOf(InvalidRequestError)
    await expect(client.verifyProof({ ...base, kind: 'storage', address: ADDRESS })).rejects.toBeInstanceOf(InvalidRequestError)
    expect(e.calls).toHaveLength(0)
  })
})

describe('createPrivateReader', () => {
  it('reads all four kinds with the right value types', async () => {
    const e = engine()
    const p = anonFetch(happyProvider)
    const r = reader(e, p)
    await expect(r.readBalance({ address: ADDRESS }).then((x) => x.value)).resolves.toBe(2_000_000_000_000_000_000n)
    await expect(r.readNonce({ address: ADDRESS }).then((x) => typeof x.value)).resolves.toBe('bigint')
    await expect(r.readStorage({ address: ADDRESS, slot: '0x0' }).then((x) => x.value)).resolves.toBe(`0x${'0'.repeat(62)}2a`)
    const code = await r.readCode({ address: ADDRESS })
    expect(code.value).toBe('0x6080')
    expect(code.receipt.privacy).toEqual({ transport: 'anon-rpc', mechanism: 'nox' })
  })

  it('sends the engine only the provider label, never the URL', async () => {
    const e = engine()
    await reader(e, anonFetch(happyProvider)).readBalance({ address: ADDRESS })
    const sent = verifyCalls(e)[0]!.params[0] as Record<string, unknown>
    expect(sent).toMatchObject({ provider: 'alpha', network: 'nox', blockHash: HASH, kind: 'balance' })
    expect(JSON.stringify(e.calls)).not.toContain('alpha.example')
    expect(JSON.stringify(e.calls)).not.toContain(KEY)
  })

  it('asks for the exact block by hash first, for eth_getProof and eth_getCode', async () => {
    const p = anonFetch(happyProvider)
    await reader(engine(), p).readCode({ address: ADDRESS })
    expect(p.calls.map((c) => [c.method, c.params.at(-1)])).toEqual([
      ['eth_getProof', { blockHash: HASH }],
      ['eth_getCode', { blockHash: HASH }],
    ])
  })

  it('falls back to the block number on -32602 and remembers it for that provider', async () => {
    const p = anonFetch((call) => {
      const block = call.params.at(-1)
      if (typeof block === 'object') return { error: { code: -32602, message: 'invalid argument 2: hex string without 0x prefix' } }
      return happyProvider(call)
    })
    const r = reader(engine(), p)
    await r.readCode({ address: ADDRESS })
    const number = `0x${ROOT.number.toString(16)}`
    // getProof: hash refused, then number. getCode: number straight away (remembered).
    expect(p.calls.map((c) => [c.method, c.params.at(-1)])).toEqual([
      ['eth_getProof', { blockHash: HASH }],
      ['eth_getProof', number],
      ['eth_getCode', number],
    ])
    await r.readBalance({ address: ADDRESS })
    expect(p.calls.at(-1)!.params.at(-1)).toBe(number)
  })

  it('treats -32000 "unknown block" as a retry by number, without remembering it', async () => {
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
    expect(p.calls.map((c) => c.params.at(-1))).toEqual([{ blockHash: HASH }, `0x${ROOT.number.toString(16)}`, { blockHash: HASH }])
  })

  it('tries providers in order: a transport failure or a forged proof moves to the next', async () => {
    const transport = anonFetch((call) => (call.url === A.url ? 'throw' : happyProvider(call)))
    const r1 = await reader(engine(), transport).readBalance({ address: ADDRESS })
    expect(r1.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')

    const e = engine((input) => (input.provider === 'alpha' ? forged : ok(input)))
    const r2 = await reader(e, anonFetch(happyProvider)).readBalance({ address: ADDRESS })
    expect(r2.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
    expect(verifyCalls(e).map((c) => (c.params[0] as { provider: string }).provider)).toEqual(['alpha', 'beta'])
  })

  it('a wrong JSON-RPC id from a provider moves to the next one', async () => {
    const p = anonFetch((call) => (call.url === A.url ? 'bad-id' : happyProvider(call)))
    const r = await reader(engine(), p).readBalance({ address: ADDRESS })
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
  })

  it('a provider that does not answer in time is aborted and the next one is used', async () => {
    const p = anonFetch((call) => (call.url === A.url ? 'hang' : happyProvider(call)))
    const r = createPrivateReader(createVeriq({ fetch: engine().fetch }), { fetch: p.fetch, network: 'nox', providers: [A, B], timeoutMs: 20 })
    await expect(r.readBalance({ address: ADDRESS }).then((x) => x.receipt.routing.providerLabel)).resolves.toBe('beta@anon-rpc:nox')
  })

  it('engine, policy and root errors stop the read: no other provider is tried', async () => {
    const policyError = { error: { code: -32014, message: 'cannot satisfy', data: { code: 'POLICY_UNSATISFIABLE' } } }
    const e = engine(() => policyError)
    await expect(reader(e, anonFetch(happyProvider)).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(PolicyUnsatisfiableError)
    expect(verifyCalls(e)).toHaveLength(1)

    const noRoot = mockEngine(() => ({ error: { code: -32011, message: 'no finalized root', data: { code: 'ROOT_UNAVAILABLE' } } }))
    const p = anonFetch(happyProvider)
    await expect(reader(noRoot, p).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(RootUnavailableError)
    expect(p.calls).toHaveLength(0)
  })

  it('a moved root is refetched up to 2 times per provider, and the budget resets for the next provider', async () => {
    // alpha: moved, moved, then forged -> next provider. beta: moved, moved, then fine.
    const script = [rootMoved, rootMoved, forged, rootMoved, rootMoved]
    const e = engine((input, n) => script[n] ?? ok(input))
    const r = await reader(e, anonFetch(happyProvider)).readBalance({ address: ADDRESS })
    expect(r.receipt.routing.providerLabel).toBe('beta@anon-rpc:nox')
    expect(verifyCalls(e).map((c) => (c.params[0] as { provider: string }).provider)).toEqual(['alpha', 'alpha', 'alpha', 'beta', 'beta', 'beta'])
  })

  it('a root that keeps moving stops after the budget instead of looping', async () => {
    const e = engine(() => rootMoved)
    await expect(reader(e, anonFetch(happyProvider)).readBalance({ address: ADDRESS })).rejects.toBeInstanceOf(InvalidRequestError)
    expect(verifyCalls(e)).toHaveLength(3)
  })

  it('errors never contain a provider URL or key, and long upstream text is cut', async () => {
    // alpha: the fetch itself fails, naming its URL. beta (last, so it is reported): a long
    // upstream message that quotes alpha's URL, its key and another URL.
    const p = anonFetch((call) =>
      call.url === A.url
        ? 'throw'
        : { error: { code: -32603, message: `upstream ${A.url} rejected key ${KEY}; see https://docs.example/x ${'x'.repeat(500)}` } },
    )
    const err = await reader(engine(), p).readBalance({ address: ADDRESS }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AllProvidersFailedError)
    const text = `${(err as Error).message} ${JSON.stringify(err)}`
    for (const secret of [KEY, 'alpha.example', 'beta.example', 'docs.example']) expect(text).not.toContain(secret)
    expect((err as Error).message.length).toBeLessThan(400)
  })

  it('validates providers and network up front', () => {
    const client = createVeriq({ fetch: engine().fetch })
    const make = (providers: PrivateProvider[], extra: { network?: string; allowInsecureLoopback?: boolean } = {}) => () =>
      createPrivateReader(client, { fetch: anonFetch(happyProvider).fetch, network: extra.network ?? 'nox', providers, ...extra })

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
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/label/)
    expect(message).not.toContain(KEY)
  })
})
