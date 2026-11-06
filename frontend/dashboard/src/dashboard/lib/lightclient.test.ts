import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPrivateReader, createVeriq, RootMismatchError } from 'veriq-client'
import { resetAnonForTests, type AnonWorker } from './anon'
import {
  DEFAULT_CHECKPOINT_SOURCE,
  DEFAULT_CONSENSUS,
  agreedCheckpoint,
  browserLightClient,
  createHeliosFetch,
  getBrowserLightClientStatus,
  resetBrowserLightClientForTests,
  startBrowserLightClient,
  subscribeBrowserLightClient,
  type BrowserLightClientState,
  type HeliosConfig,
  type HeliosLike,
} from './lightclient'

const CHECKPOINT = `0x${'c1'.repeat(32)}`
const CHECKPOINT2 = `0x${'c2'.repeat(32)}`
const NOW_S = Math.floor(Date.now() / 1000)
const BLOCK = { number: '0xb84702', hash: `0x${'aa'.repeat(32)}`, stateRoot: `0x${'bb'.repeat(32)}`, timestamp: `0x${(NOW_S - 900).toString(16)}` }
const ROOT = { number: 0xb84702, hash: BLOCK.hash, stateRoot: BLOCK.stateRoot }

const status = (roots: string[], healthy = roots.map(() => true)) => ({
  data: {
    upstreams: Object.fromEntries(
      roots.map((root, i) => [`node-${i}`, { name: `node-${i}`, healthy: healthy[i], finality: { finalized: { epoch: '1', root } } }]),
    ),
  },
})

/** Fake Nox worker: answers checkpointz with `checkpointz()`; records every URL it is asked for. */
function fakeNox(checkpointz: () => unknown = () => status([CHECKPOINT, CHECKPOINT]), ready = true) {
  const urls: string[] = []
  const worker: AnonWorker = {
    ready: ready ? Promise.resolve() : Promise.reject(new Error('mixnet unreachable')),
    fetch: vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/checkpointz/')) return new Response(JSON.stringify(checkpointz()))
      return new Response(JSON.stringify({ ok: true, url }))
    }),
    close: vi.fn(),
  }
  worker.ready.catch(() => {})
  resetAnonForTests(() => worker)
  return { urls, worker }
}

/** Fake Helios: syncs (or fails) as told, serves `block` as the finalized block. */
function fakeHelios(opts: { fail?: (config: HeliosConfig) => string | null; block?: () => typeof BLOCK } = {}) {
  const configs: HeliosConfig[] = []
  const factory = vi.fn(async (config: HeliosConfig): Promise<HeliosLike> => {
    configs.push(config)
    const failure = opts.fail?.(config) ?? null
    return {
      waitSynced: async () => {
        if (failure) throw new Error(failure)
      },
      request: async ({ method }) => {
        if (method === 'eth_getBlockByNumber') return (opts.block ?? (() => BLOCK))()
        if (method === 'helios_getCurrentCheckpoint') return CHECKPOINT2
        throw new Error(`unexpected ${method}`)
      },
      shutdown: vi.fn(async () => {}),
    }
  })
  resetBrowserLightClientForTests(factory)
  return { factory, configs }
}

beforeEach(() => {
  vi.stubEnv('VITE_ANON', 'on')
  vi.stubEnv('VITE_BROWSER_LIGHT_CLIENT', 'on')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startBrowserLightClient', () => {
  it('waits for Nox, bootstraps from the checkpointz root through Nox, and reports the finalized block', async () => {
    const nox = fakeNox()
    const helios = fakeHelios()
    const states: BrowserLightClientState[] = []
    const off = subscribeBrowserLightClient(() => states.push(getBrowserLightClientStatus().state))

    await startBrowserLightClient()
    off()
    expect(states).toEqual(['waiting', 'syncing', 'synced'])
    const s = getBrowserLightClientStatus()
    expect(s.finalized).toEqual({ ...ROOT, timestamp: NOW_S - 900 })
    expect(s.checkpoint).toBe(CHECKPOINT)
    expect(s.checkpointSource).toBe(new URL(DEFAULT_CHECKPOINT_SOURCE).hostname)
    expect(s.syncMs).toBeGreaterThanOrEqual(0)
    // checkpointz was asked through Nox, never directly.
    expect(nox.urls).toEqual([`${DEFAULT_CHECKPOINT_SOURCE}/checkpointz/v1/status`])
    // Helios only ever sees the placeholder hosts.
    expect(helios.configs).toEqual([
      { consensusRpc: 'https://consensus.helios.invalid', executionRpc: 'https://execution.helios.invalid', network: 'sepolia', checkpoint: CHECKPOINT, dbType: 'config' },
    ])
  })

  it('starts one Helios however often it is called', async () => {
    fakeNox()
    const helios = fakeHelios()
    await Promise.all([startBrowserLightClient(), startBrowserLightClient(), startBrowserLightClient()])
    expect(helios.factory).toHaveBeenCalledTimes(1)
  })

  it('Nox failed: the light client fails and Helios is never started (it never syncs directly)', async () => {
    fakeNox(undefined, false)
    const helios = fakeHelios()
    await startBrowserLightClient()
    expect(getBrowserLightClientStatus().state).toBe('failed')
    expect(getBrowserLightClientStatus().error).toMatch(/over nox/)
    expect(helios.factory).not.toHaveBeenCalled()
  })

  it('healthy checkpointz upstreams that disagree are refused (after one retry)', async () => {
    vi.useFakeTimers()
    fakeNox(() => status([CHECKPOINT, CHECKPOINT2]))
    const helios = fakeHelios()
    const done = startBrowserLightClient()
    await vi.advanceTimersByTimeAsync(7_000)
    await done
    expect(getBrowserLightClientStatus().state).toBe('failed')
    expect(getBrowserLightClientStatus().error).toMatch(/disagree/)
    expect(helios.factory).not.toHaveBeenCalled()
  })

  it('a bootstrap the beacon API no longer serves is retried once with a fresh checkpoint', async () => {
    vi.useFakeTimers()
    let calls = 0
    fakeNox(() => status([calls++ === 0 ? CHECKPOINT : CHECKPOINT2]))
    const helios = fakeHelios({ fail: (c) => (c.checkpoint === CHECKPOINT ? 'could not fetch bootstrap: status 500' : null) })
    const done = startBrowserLightClient()
    await vi.advanceTimersByTimeAsync(7_000)
    await done
    expect(getBrowserLightClientStatus().state).toBe('synced')
    expect(helios.configs.map((c) => c.checkpoint)).toEqual([CHECKPOINT, CHECKPOINT2])
  })

  it('a sync that keeps failing ends as failed with the reason', async () => {
    vi.useFakeTimers()
    fakeNox()
    fakeHelios({ fail: () => 'sync failed: invalid sync committee signature' })
    const done = startBrowserLightClient()
    await vi.advanceTimersByTimeAsync(7_000)
    await done
    expect(getBrowserLightClientStatus()).toMatchObject({ state: 'failed', error: 'sync failed: invalid sync committee signature' })
  })

  it('saves the checkpoint Helios reached and reuses it on a reload within 5 minutes', async () => {
    const first = fakeNox()
    fakeHelios()
    await startBrowserLightClient()
    expect(first.urls).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('veriq.browserHelios.v1') ?? '{}')).toMatchObject({ checkpoint: CHECKPOINT2 })

    // "Reload": fresh singletons, same localStorage.
    const second = fakeNox()
    const helios = fakeHelios()
    await startBrowserLightClient()
    expect(second.urls).toHaveLength(0) // checkpointz not needed
    expect(helios.configs[0]?.checkpoint).toBe(CHECKPOINT2)
    expect(getBrowserLightClientStatus().checkpointSource).toMatch(/saved in this browser/)
  })

  it('switched off (or Anon-RPC off): state off, nothing started', async () => {
    vi.stubEnv('VITE_BROWSER_LIGHT_CLIENT', 'off')
    const nox = fakeNox()
    const helios = fakeHelios()
    await startBrowserLightClient()
    expect(getBrowserLightClientStatus().state).toBe('off')
    expect(helios.factory).not.toHaveBeenCalled()
    expect(nox.urls).toHaveLength(0)

    vi.stubEnv('VITE_BROWSER_LIGHT_CLIENT', 'on')
    vi.stubEnv('VITE_ANON', 'off')
    resetBrowserLightClientForTests(helios.factory)
    await startBrowserLightClient()
    expect(getBrowserLightClientStatus().state).toBe('off')
  })
})

describe('browserLightClient.finalized', () => {
  it('null until synced, then the finalized block', async () => {
    fakeNox()
    fakeHelios()
    await expect(browserLightClient.finalized()).resolves.toBeNull()
    await startBrowserLightClient()
    await expect(browserLightClient.finalized()).resolves.toEqual(ROOT)
  })

  it('a finalized block older than 30 minutes counts as not synced', async () => {
    fakeNox()
    fakeHelios({ block: () => ({ ...BLOCK, timestamp: `0x${(NOW_S - 31 * 60).toString(16)}` }) })
    await startBrowserLightClient()
    await expect(browserLightClient.finalized()).resolves.toBeNull()
  })

  it('feeds the private reader: a different engine root for the same block is ROOT_MISMATCH', async () => {
    fakeNox()
    fakeHelios()
    await startBrowserLightClient()
    const engineFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string }
      const result = { number: ROOT.number, hash: ROOT.hash, stateRoot: `0x${'ee'.repeat(32)}`, rootSource: 'local-light-client', verified: true }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
    const providerFetch = vi.fn(async () => new Response('{}'))
    const reader = createPrivateReader(createVeriq({ fetch: engineFetch as unknown as typeof fetch }), {
      fetch: providerFetch,
      network: 'nox',
      providers: [{ label: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com' }],
      lightClient: browserLightClient,
    })
    await expect(reader.readBalance({ address: `0x${'11'.repeat(20)}` })).rejects.toBeInstanceOf(RootMismatchError)
    expect(providerFetch).not.toHaveBeenCalled()
  })
})

describe('createHeliosFetch', () => {
  const routes = { 'consensus.helios.invalid': DEFAULT_CONSENSUS, 'execution.helios.invalid': 'https://rpc.example/v3/key' }

  it('sends placeholder hosts through Nox to the real endpoint, keeping path, query, method and body', async () => {
    const viaNox = vi.fn(async () => new Response('{"data":1}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const direct = vi.fn(async () => new Response('direct')) as unknown as typeof fetch
    const f = createHeliosFetch(routes, viaNox, direct)

    const beacon = await f(new Request('https://consensus.helios.invalid/eth/v1/beacon/light_client/updates?start_period=1406&count=128'))
    expect(viaNox).toHaveBeenLastCalledWith(`${DEFAULT_CONSENSUS}/eth/v1/beacon/light_client/updates?start_period=1406&count=128`, expect.objectContaining({ method: 'GET', body: undefined }))
    expect(await beacon.json()).toEqual({ data: 1 })
    // reqwest (wasm) parses response.url: it must be a real URL.
    expect(beacon.url).toBe('https://consensus.helios.invalid/eth/v1/beacon/light_client/updates?start_period=1406&count=128')

    const body = '{"method":"eth_getBlockByHash","params":[],"id":0,"jsonrpc":"2.0"}'
    await f('https://execution.helios.invalid/', { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    expect(viaNox).toHaveBeenLastCalledWith('https://rpc.example/v3/key', expect.objectContaining({ method: 'POST', body }))
    expect(direct).not.toHaveBeenCalled()
  })

  it('any other URL goes to the original fetch untouched, never through Nox', async () => {
    const viaNox = vi.fn(async () => new Response('nox'))
    const direct = vi.fn(async () => new Response('direct')) as unknown as typeof fetch
    const f = createHeliosFetch(routes, viaNox, direct)
    await f('/engine', { method: 'POST', body: '{}' })
    await f('data:application/wasm;base64,AGFzbQ==')
    expect(direct).toHaveBeenCalledTimes(2)
    expect(viaNox).not.toHaveBeenCalled()
  })
})

describe('agreedCheckpoint', () => {
  it('needs every healthy upstream to agree; unhealthy ones are ignored', () => {
    expect(agreedCheckpoint(status([CHECKPOINT, CHECKPOINT2], [true, false]))).toBe(CHECKPOINT)
    expect(() => agreedCheckpoint(status([CHECKPOINT, CHECKPOINT2]))).toThrow(/disagree/)
    expect(() => agreedCheckpoint(status([CHECKPOINT], [false]))).toThrow(/no healthy/)
    expect(() => agreedCheckpoint(status(['0x1234']))).toThrow(/no finalized root/)
    expect(() => agreedCheckpoint({})).toThrow(/no healthy/)
  })
})
