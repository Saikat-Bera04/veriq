/**
 * Anon-RPC for the dashboard: one anonymizing worker per page, started when /app loads.
 *
 * Reads that go through the private reader are fetched by the browser through the mixnet and
 * verified (here and by the engine), so providers see the mixnet's exit, not this browser.
 * Only reads use it: /health, receipts, provider health and the Attack Lab stay direct.
 *
 * The network follows the chain (S6, lib/chain.ts): Nox on Sepolia, Nym (`mixFetch`) on
 * mainnet. A network the chain does not allow, or Tor (no browser fetch), is a typed failure.
 */
import { useSyncExternalStore } from 'react'
import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { assertNetworkForChain, createPrivateReader, loadVerifier, type PrivateProvider, type PrivateReader, type VeriqClient } from 'veriq-client'
// The WebAssembly build of the engine's verifier, shipped with the SDK; fetched on the first read.
import verifierWasmUrl from 'veriq-client/verifier.wasm?url'
import { browserLightClient, isBrowserLightClientEnabled } from './lightclient'
import { anonNetwork, CHAINS, currentChain } from './chain'

/** Nox's worker specifier contract on Sepolia (proven in M0, docs/ANON_RPC_FEASIBILITY.md). */
export const NOX_SEPOLIA = '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A'
/** @deprecated The network follows the chain: use anonNetwork() (lib/chain.ts). Sepolia's. */
export const ANON_NETWORK = 'nox'
export { anonNetwork } from './chain'
/** Public, keyless. Used directly (not through Nox) only once, to read the specifier contract. */
export const BOOTSTRAP_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
/**
 * Keyless Sepolia providers that serve eth_getProof at the finalized block (see lib/chain.ts for
 * every chain). The first one is also browser Helios's execution RPC.
 */
export const DEFAULT_PROVIDERS: PrivateProvider[] = CHAINS.sepolia.providers
/** Joining the mixnet normally takes seconds; past this the dashboard reports it as failed. */
export const START_TIMEOUT_MS = 90_000

export type AnonState = 'idle' | 'connecting' | 'ready' | 'failed'

export interface AnonStatus {
  state: AnonState
  /** Set when `state` is `failed`. */
  error?: AnonUnavailableError
  /** Milliseconds from start to ready. */
  readyMs?: number
}

/** Nox could not be joined (or is switched off): private reads cannot run. Never a direct fallback. */
export class AnonUnavailableError extends Error {
  override name = 'AnonUnavailableError'
}

/** The part of AnonRpcWorker (or the Nym tunnel) this module uses (tests pass a fake). */
export interface AnonWorker {
  ready: Promise<void>
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  close(): void
}
export type WorkerFactory = (init: ConstructorParameters<typeof AnonRpcWorker>[0]) => AnonWorker
/** Makes the Nym worker (mainnet). Tests pass a fake. */
export type NymFactory = () => AnonWorker

/**
 * Nym's mixFetch behind the AnonWorker shape. The ~6 MB (gzip) tunnel bundle loads only here.
 * `signal` is dropped: the tunnel runs in a Web Worker and an AbortSignal cannot be sent there;
 * the private reader's own timeout still bounds every request.
 */
const defaultNymFactory: NymFactory = () => {
  const nym = import('@nymproject/mix-fetch')
  const ready = nym.then((m) => m.setupMixTunnel())
  return {
    ready,
    fetch: async (input, init) => {
      const m = await nym
      await ready
      const { signal: _signal, ...rest } = init ?? {}
      return m.mixFetch(input, rest)
    },
    close: () => {
      void nym.then((m) => m.disconnectMixTunnel()).catch(() => {})
    },
  }
}

/** `VITE_ANON=off` builds the app without private reads (no worker, no toggle). Default: on. */
export function isAnonAvailable(): boolean {
  const value = String(import.meta.env.VITE_ANON ?? '').trim().toLowerCase()
  return !['off', '0', 'false', 'no'].includes(value)
}

/** `private`: reads go through the mixnet (the default). `direct`: the engine asks providers itself. */
export type AnonMode = 'private' | 'direct'
export const MODE_STORAGE_KEY = 'veriq.readMode'

function storedMode(): AnonMode {
  try {
    return sessionStorage.getItem(MODE_STORAGE_KEY) === 'direct' ? 'direct' : 'private'
  } catch {
    return 'private'
  }
}

/** The read path right now. Always `direct` when the build has Anon-RPC off. */
export function getAnonMode(): AnonMode {
  if (!isAnonAvailable()) return 'direct'
  // Cached on the singleton: sessionStorage is read once per page, then setAnonMode keeps both.
  const s = anon()
  s.mode ??= storedMode()
  return s.mode
}

/** Reads go through the mixnet right now. Read at call time, so the toggle takes effect at once. */
export function isAnonEnabled(): boolean {
  return getAnonMode() === 'private'
}

/**
 * Switch the read path; kept in sessionStorage for this tab. Going direct keeps the worker
 * running (warm), so switching back needs no new mixnet join. Going private starts it if needed.
 */
export function setAnonMode(mode: AnonMode): void {
  try {
    sessionStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // storage unavailable: the switch still applies to this page
  }
  anon().mode = mode
  notify()
  if (mode === 'private' && isAnonAvailable()) void startAnon()
}

export function useAnonMode(): AnonMode {
  return useSyncExternalStore(subscribeAnon, getAnonMode, getAnonMode)
}

/** S5: check proofs in the browser too. On unless `VITE_BROWSER_VERIFIER=off`; needs Anon-RPC. */
export function isBrowserVerifierEnabled(): boolean {
  const value = String(import.meta.env.VITE_BROWSER_VERIFIER ?? '').trim().toLowerCase()
  return isAnonEnabled() && !['off', '0', 'false', 'no'].includes(value)
}

/** `VITE_ANON_PROVIDERS="label=https://url,label2=https://url2"`; empty means the chain's defaults. */
export function parseProviders(raw: string | undefined): PrivateProvider[] {
  if (!raw || !raw.trim()) {
    try {
      return currentChain().providers
    } catch {
      return DEFAULT_PROVIDERS
    }
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('=')
      // createPrivateReader validates labels and URLs (HTTPS, unique), without echoing them.
      return at < 0 ? { label: '', url: entry } : { label: entry.slice(0, at).trim(), url: entry.slice(at + 1).trim() }
    })
}

/** Bootstrap: read the specifier contract directly from PublicNode, once. */
const bootstrapProvider = {
  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    const res = await fetch(BOOTSTRAP_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    })
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } }
    if (body.error) throw Object.assign(new Error(body.error.message ?? 'bootstrap RPC error'), { code: body.error.code })
    return body.result
  },
}

interface AnonSingleton {
  status: AnonStatus
  worker: AnonWorker | null
  starting: Promise<void> | null
  reader: { client: VeriqClient; reader: PrivateReader } | null
  listeners: Set<() => void>
  factory: WorkerFactory
  nymFactory: NymFactory
  mode?: AnonMode
}

// On globalThis, so a hot-reloaded copy of this module finds the worker that is already running.
const KEY = Symbol.for('veriq.dashboard.anon')
const holder = globalThis as unknown as { [KEY]?: AnonSingleton }
const defaultFactory: WorkerFactory = (init) => new AnonRpcWorker(init)

function anon(): AnonSingleton {
  holder[KEY] ??= { status: { state: 'idle' }, worker: null, starting: null, reader: null, listeners: new Set(), factory: defaultFactory, nymFactory: defaultNymFactory }
  return holder[KEY]
}

function notify() {
  for (const listener of anon().listeners) listener()
}

function setStatus(status: AnonStatus) {
  anon().status = status
  notify()
}

export function getAnonStatus(): AnonStatus {
  return anon().status
}

export function subscribeAnon(listener: () => void): () => void {
  anon().listeners.add(listener)
  return () => anon().listeners.delete(listener)
}

/** Live worker status for components. */
export function useAnonStatus(): AnonStatus {
  return useSyncExternalStore(subscribeAnon, getAnonStatus, getAnonStatus)
}

/**
 * Starts the Nox worker once per page. Safe to call any number of times (StrictMode, HMR, every
 * read): later calls get the same promise. Resolves when ready; rejects with AnonUnavailableError
 * on failure or after START_TIMEOUT_MS, and the failure is kept in getAnonStatus().
 */
export function startAnon(): Promise<void> {
  const s = anon()
  if (s.starting) return s.starting
  if (!isAnonAvailable()) {
    s.starting = Promise.reject(new AnonUnavailableError('Anon-RPC is switched off (VITE_ANON=off)'))
    s.starting.catch(() => {}) // a rejection nobody awaited is not an error
    return s.starting
  }
  const started = Date.now()
  setStatus({ state: 'connecting' })
  const network = anonNetwork()
  let worker: AnonWorker
  try {
    // The network must carry the chain (Nox: Sepolia; Nym, Tor: mainnet), else nothing starts.
    assertNetworkForChain(currentChain().chainId, network)
    if (network === 'nox') {
      worker = s.factory({ address: NOX_SEPOLIA, preExisting: { rpcProvider: bootstrapProvider } } as ConstructorParameters<typeof AnonRpcWorker>[0])
    } else if (network === 'nym') {
      worker = s.nymFactory()
    } else {
      throw new Error(`${network} has no browser fetch (Tor needs a SOCKS proxy, which a web page cannot open); use nym in the browser, or ${network} from Node with the SDK`)
    }
  } catch (err) {
    return fail(err)
  }
  s.worker = worker
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${network} did not become ready within ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS)
  })
  s.starting = Promise.race([worker.ready, timeout]).then(
    () => {
      clearTimeout(timer)
      setStatus({ state: 'ready', readyMs: Date.now() - started })
    },
    (err: unknown) => {
      clearTimeout(timer)
      throw failure(err)
    },
  )
  s.starting.catch(() => {})
  return s.starting

  function fail(err: unknown): Promise<void> {
    s.starting = Promise.reject(failure(err))
    s.starting.catch(() => {})
    return s.starting
  }

  function failure(err: unknown): AnonUnavailableError {
    try {
      s.worker?.close()
    } catch {
      // already gone
    }
    s.worker = null
    const reason = err instanceof Error ? err.message : String(err)
    const error = new AnonUnavailableError(`Could not start private reads over ${anonNetwork()}: ${reason}`, { cause: err })
    setStatus({ state: 'failed', error })
    return error
  }
}

/** The running worker's fetch: every request it makes goes through Nox. Starts Nox if needed. */
export async function getAnonFetch(): Promise<(input: string, init?: RequestInit) => Promise<Response>> {
  await startAnon()
  const worker = anon().worker
  if (!worker) throw new AnonUnavailableError('the Nox worker is not running')
  return (input, init) => worker.fetch(input, init)
}

/** The private reader over the running worker, created once per client. Starts Nox if needed. */
export async function getPrivateReader(client: VeriqClient): Promise<PrivateReader> {
  const fetchThroughNox = await getAnonFetch()
  const s = anon()
  if (s.reader?.client === client) return s.reader.reader
  const reader = createPrivateReader(client, {
    fetch: fetchThroughNox,
    network: anonNetwork(),
    // S6: refuses a network that does not carry this chain, and an engine on another chain.
    chainId: currentChain().chainId,
    providers: parseProviders(import.meta.env.VITE_ANON_PROVIDERS),
    // S4.2: when Helios in this tab is synced, its finalized block is the one read, and the
    // engine's root must be that same block (else ROOT_MISMATCH).
    ...(isBrowserLightClientEnabled() ? { lightClient: browserLightClient } : {}),
    // S5: every proof is checked here first; with browser Helios synced, a read also works
    // while the engine is down (local-only receipt). If the .wasm fails to load, the engine
    // verifies alone and its receipt says BROWSER_VERIFIER_UNAVAILABLE.
    ...(isBrowserVerifierEnabled() ? { verifier: () => loadVerifier(verifierWasmUrl) } : {}),
  })
  s.reader = { client, reader }
  return reader
}

/** How a read reached its provider, from the receipt: `anon-rpc · nox`, or `direct`. */
export function transportLabel(privacy: { transport: string; mechanism?: string | null }): string {
  return privacy.mechanism ? `${privacy.transport} · ${privacy.mechanism}` : privacy.transport
}

/** Tests only: use a fake worker factory and forget any running worker. */
export function resetAnonForTests(factory: WorkerFactory = defaultFactory, nymFactory: NymFactory = defaultNymFactory) {
  const s = anon()
  try {
    s.worker?.close()
  } catch {
    // ignore
  }
  holder[KEY] = { status: { state: 'idle' }, worker: null, starting: null, reader: null, listeners: s.listeners, factory, nymFactory }
}
