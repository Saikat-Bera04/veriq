import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChainMismatchError, createVeriq } from 'veriq-client'
import { anonNetwork, CHAINS, currentChain } from './chain'
import { getAnonStatus, getPrivateReader, parseProviders, resetAnonForTests, startAnon, type AnonWorker } from './anon'
import { getBrowserLightClientStatus, resetBrowserLightClientForTests, startBrowserLightClient, type HeliosConfig, type HeliosLike } from './lightclient'

const MAINNET_CHECKPOINT = `0x${'9d'.repeat(32)}`

/** A ready fake worker that records URLs; answers checkpointz and JSON-RPC proofs. */
function fakeWorker(urls: string[]): AnonWorker {
  return {
    ready: Promise.resolve(),
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url)
      if (url.includes('/checkpointz/')) {
        return Response.json({ data: { upstreams: { a: { healthy: true, finality: { finalized: { root: MAINNET_CHECKPOINT } } } } } })
      }
      const body = JSON.parse(String(init?.body)) as { id: number }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { accountProof: [] } })
    }),
    close: vi.fn(),
  }
}

/** Both transports faked; returns which one was made. */
function transports() {
  const made = { nox: 0, nym: 0 }
  const urls: string[] = []
  resetAnonForTests(
    () => {
      made.nox++
      return fakeWorker(urls)
    },
    () => {
      made.nym++
      return fakeWorker(urls)
    },
  )
  return { made, urls }
}

beforeEach(() => {
  vi.stubEnv('VITE_ANON', 'on')
})

describe('the private network follows VITE_CHAIN', () => {
  it('Sepolia (default): Nox, the Sepolia providers', async () => {
    vi.stubEnv('VITE_CHAIN', '')
    expect(currentChain()).toBe(CHAINS.sepolia)
    expect(anonNetwork()).toBe('nox')
    expect(parseProviders('').map((p) => p.label)).toEqual(['ethpandaops', 'publicnode'])
    const t = transports()
    await startAnon()
    expect(t.made).toEqual({ nox: 1, nym: 0 })
  })

  it('mainnet: Nym, the mainnet providers, never a Nox worker', async () => {
    vi.stubEnv('VITE_CHAIN', 'mainnet')
    expect(currentChain().chainId).toBe(1)
    expect(anonNetwork()).toBe('nym')
    expect(parseProviders(undefined).map((p) => p.label)).toEqual(['publicnode', 'drpc', 'blastapi'])
    const t = transports()
    await startAnon()
    expect(t.made).toEqual({ nox: 0, nym: 1 })
    expect(getAnonStatus().state).toBe('ready')
  })

  it('mainnet with Nox forced: refused before any worker starts (PrivacyUnavailable)', async () => {
    vi.stubEnv('VITE_CHAIN', 'mainnet')
    vi.stubEnv('VITE_ANON_NETWORK', 'nox')
    const t = transports()
    await expect(startAnon()).rejects.toThrow(/"nox" does not carry chain 1; use "nym" or "tor"/)
    expect(t.made).toEqual({ nox: 0, nym: 0 })
    expect(getAnonStatus().state).toBe('failed')
  })

  it('Tor in the browser: a typed failure, never a direct read', async () => {
    vi.stubEnv('VITE_CHAIN', 'mainnet')
    vi.stubEnv('VITE_ANON_NETWORK', 'tor')
    const t = transports()
    await expect(startAnon()).rejects.toThrow(/tor has no browser fetch/)
    expect(t.made).toEqual({ nox: 0, nym: 0 })
  })

  it('an unknown chain is refused', async () => {
    vi.stubEnv('VITE_CHAIN', 'holesky')
    transports()
    await expect(startAnon()).rejects.toThrow(/VITE_CHAIN must be sepolia or mainnet/)
  })

  it('a mainnet dashboard pointed at a Sepolia engine: ChainMismatchError, no provider asked', async () => {
    vi.stubEnv('VITE_CHAIN', 'mainnet')
    const t = transports()
    const engineFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number }
      const result = { number: 1, hash: `0x${'aa'.repeat(32)}`, stateRoot: `0x${'bb'.repeat(32)}`, rootSource: 'local-light-client', verified: true, chainId: 11155111 }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    })
    const reader = await getPrivateReader(createVeriq({ fetch: engineFetch as unknown as typeof fetch }))
    await expect(reader.readBalance({ address: `0x${'11'.repeat(20)}` })).rejects.toBeInstanceOf(ChainMismatchError)
    expect(t.urls).toHaveLength(0)
  })
})

describe('browser Helios follows the chain', () => {
  it('mainnet: Lodestar mainnet, beaconcha.in checkpointz, Helios network mainnet, its own saved checkpoint', async () => {
    vi.stubEnv('VITE_CHAIN', 'mainnet')
    vi.stubEnv('VITE_BROWSER_LIGHT_CLIENT', 'on')
    const t = transports()
    const configs: HeliosConfig[] = []
    const helios: HeliosLike = {
      waitSynced: async () => {},
      request: async ({ method }) =>
        method === 'eth_getBlockByNumber'
          ? { number: '0x1', hash: `0x${'aa'.repeat(32)}`, stateRoot: `0x${'bb'.repeat(32)}`, timestamp: `0x${Math.floor(Date.now() / 1000 - 600).toString(16)}` }
          : `0x${'c3'.repeat(32)}`,
    }
    resetBrowserLightClientForTests(async (config) => {
      configs.push(config)
      return helios
    })
    await startBrowserLightClient()
    expect(getBrowserLightClientStatus().state).toBe('synced')
    expect(t.urls[0]).toBe('https://sync-mainnet.beaconcha.in/checkpointz/v1/status')
    expect(configs[0]).toMatchObject({ network: 'mainnet', checkpoint: MAINNET_CHECKPOINT })
    expect(localStorage.getItem('veriq.browserHelios.v1.mainnet')).toContain('c3c3')
    expect(localStorage.getItem('veriq.browserHelios.v1')).toBeNull()
  })
})
