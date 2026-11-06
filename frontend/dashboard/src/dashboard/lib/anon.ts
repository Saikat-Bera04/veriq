/**
 * Anon-RPC (Nox) for the dashboard: one worker per page, started when /app loads.
 *
 * Reads that go through the private reader are fetched by the browser through Nox and verified
 * by the engine against its own root, so providers see the mixnet's exit, not this browser.
 * Only reads use it: /health, receipts, provider health and the Attack Lab stay direct.
 */
import { useSyncExternalStore } from 'react'
import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { createPrivateReader, type PrivateProvider, type PrivateReader, type VeriqClient } from 'veriq-client'

/** Nox's worker specifier contract on Sepolia (proven in M0, docs/ANON_RPC_FEASIBILITY.md). */
export const NOX_SEPOLIA = '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A'
export const ANON_NETWORK = 'nox'
/** Public, keyless. Used directly (not through Nox) only once, to read the specifier contract. */
export const BOOTSTRAP_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
export const DEFAULT_PROVIDERS: PrivateProvider[] = [{ label: 'publicnode', url: BOOTSTRAP_RPC }]
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

/** The part of AnonRpcWorker this module uses (tests pass a fake). */
export interface AnonWorker {
  ready: Promise<void>
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  close(): void
}
export type WorkerFactory = (init: ConstructorParameters<typeof AnonRpcWorker>[0]) => AnonWorker

/** `VITE_ANON=off` keeps every read on the direct engine path. Default: on. Read at call time. */
export function isAnonEnabled(): boolean {
  const value = String(import.meta.env.VITE_ANON ?? '').trim().toLowerCase()
  return !['off', '0', 'false', 'no'].includes(value)
}

/** `VITE_ANON_PROVIDERS="label=https://url,label2=https://url2"`; empty means PublicNode. */
export function parseProviders(raw: string | undefined): PrivateProvider[] {
  if (!raw || !raw.trim()) return DEFAULT_PROVIDERS
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
}

// On globalThis, so a hot-reloaded copy of this module finds the worker that is already running.
const KEY = Symbol.for('veriq.dashboard.anon')
const holder = globalThis as unknown as { [KEY]?: AnonSingleton }
const defaultFactory: WorkerFactory = (init) => new AnonRpcWorker(init)

function anon(): AnonSingleton {
  holder[KEY] ??= { status: { state: 'idle' }, worker: null, starting: null, reader: null, listeners: new Set(), factory: defaultFactory }
  return holder[KEY]
}

function setStatus(status: AnonStatus) {
  const s = anon()
  s.status = status
  for (const listener of s.listeners) listener()
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
  if (!isAnonEnabled()) {
    s.starting = Promise.reject(new AnonUnavailableError('Anon-RPC is switched off (VITE_ANON=off)'))
    s.starting.catch(() => {}) // a rejection nobody awaited is not an error
    return s.starting
  }
  const started = Date.now()
  setStatus({ state: 'connecting' })
  let worker: AnonWorker
  try {
    worker = s.factory({ address: NOX_SEPOLIA, preExisting: { rpcProvider: bootstrapProvider } } as ConstructorParameters<typeof AnonRpcWorker>[0])
  } catch (err) {
    return fail(err)
  }
  s.worker = worker
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Nox did not become ready within ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS)
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
    const error = new AnonUnavailableError(`Could not join the Nox mixnet: ${reason}`, { cause: err })
    setStatus({ state: 'failed', error })
    return error
  }
}

/** The private reader over the running worker, created once per client. Starts Nox if needed. */
export async function getPrivateReader(client: VeriqClient): Promise<PrivateReader> {
  await startAnon()
  const s = anon()
  if (s.reader?.client === client) return s.reader.reader
  const worker = s.worker
  if (!worker) throw new AnonUnavailableError('the Nox worker is not running')
  const reader = createPrivateReader(client, {
    fetch: (input, init) => worker.fetch(input, init),
    network: ANON_NETWORK,
    providers: parseProviders(import.meta.env.VITE_ANON_PROVIDERS),
  })
  s.reader = { client, reader }
  return reader
}

/** How a read reached its provider, from the receipt: `anon-rpc · nox`, or `direct`. */
export function transportLabel(privacy: { transport: string; mechanism?: string | null }): string {
  return privacy.mechanism ? `${privacy.transport} · ${privacy.mechanism}` : privacy.transport
}

/** Tests only: use a fake worker factory and forget any running worker. */
export function resetAnonForTests(factory: WorkerFactory = defaultFactory) {
  const s = anon()
  try {
    s.worker?.close()
  } catch {
    // ignore
  }
  holder[KEY] = { status: { state: 'idle' }, worker: null, starting: null, reader: null, listeners: s.listeners, factory }
}
