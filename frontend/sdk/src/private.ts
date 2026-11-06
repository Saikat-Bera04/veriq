/**
 * Private reads: the provider request goes through a fetch you supply (Anon-RPC), the proof is
 * verified by the engine against its own Helios root. The engine never contacts the provider
 * for these reads, so the provider sees the anonymizing network's exit, not your IP.
 *
 * @example
 * import { AnonRpcWorker } from '@anon-rpc/browser-harness'
 * const nox = new AnonRpcWorker({ address: NOX_SEPOLIA, preExisting: { rpcProvider } })
 * const reader = createPrivateReader(veriq, {
 *   fetch: nox.fetch,
 *   network: 'nox',
 *   providers: [{ label: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com' }],
 * })
 * const { value, receipt } = await reader.readBalance({ address })
 * receipt.privacy.transport // 'anon-rpc'
 */
import type { BrowserRoot, RootInfo, VeriqClient } from './client'
import { assertAddress, assertSlot, attemptsFromReceipt } from './client'
import {
  ERROR_CODES,
  AllProvidersFailedError,
  EngineUnreachableError,
  InternalError,
  InvalidProofError,
  InvalidRequestError,
  RootMismatchError,
  RootUnavailableError,
  VeriqError,
} from './errors'
import { TrustReceiptSchema } from './schema'
import type { Hex, Policy, TrustReceipt, VerifiedResult } from './types'
import type { BrowserVerifier } from './wasm'

/** A provider the private reader may ask, through the anonymizing fetch. */
export interface PrivateProvider {
  /** Shown in receipts and logs (1-64 of letters, digits, `_`, `-`, `.`). Never the URL. */
  label: string
  /** HTTPS JSON-RPC endpoint. It must allow browser requests (CORS) and serve `eth_getProof`. */
  url: string
}

export interface PrivateReaderOptions {
  /** The anonymizing fetch, e.g. `AnonRpcWorker.fetch` from `@anon-rpc/browser-harness`. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  /** Network name recorded in the receipt (`privacy.mechanism`), e.g. `'nox'`. Same rules as a label. */
  network: string
  /** Tried in order; the next one is used when a provider fails or sends a bad proof. */
  providers: PrivateProvider[]
  /** Per provider request. Default 30 s (mixnets add per-hop delay). */
  timeoutMs?: number
  /** Tests only: allow `http://` to localhost / 127.0.0.1 / [::1]. Every other URL must be HTTPS. */
  allowInsecureLoopback?: boolean
  /**
   * A light client in the browser (S4.2, e.g. Helios synced over Nox). When it is synced, the
   * read uses its finalized block and the engine's `veriq_getRoot` must be the very same block:
   * a different hash or state root for that number is a ROOT_MISMATCH and nothing is read.
   * While it is not synced (`null`), the engine's root is used alone and the receipt has no
   * BROWSER_LIGHT_CLIENT marker.
   */
  lightClient?: BrowserLightClient
  /**
   * How long the two light clients may disagree about *which* block is finalized (one is a
   * few seconds behind at an epoch boundary) before the read gives up. Default 30 s.
   */
  alignTimeoutMs?: number
  /**
   * S5: check every proof in the browser first (the WebAssembly build of the engine's verifier,
   * see `loadVerifier`). A proof that fails here never reaches the engine: the next provider is
   * asked. The engine still checks what it is sent and marks the receipt
   * `verifierLocation: "browser"`. A function is called once, on the first read (lazy load); if
   * it rejects, the engine verifies alone and the receipt carries BROWSER_VERIFIER_UNAVAILABLE.
   *
   * With a synced `lightClient` too, a read needs no engine at all: if the engine cannot be
   * reached, the value comes back with a receipt made in the browser (LOCAL_ONLY warning,
   * `identity.requestId` starting `local-`), which the engine never stored.
   */
  verifier?: BrowserVerifier | (() => Promise<BrowserVerifier>)
}

/** A light client running in the browser that reports its latest finalized block. */
export interface BrowserLightClient {
  /** The finalized block, or `null` while not synced (or stale, or failed). */
  finalized(): Promise<BrowserRoot | null>
}

export interface PrivateReader {
  readBalance(args: { address: string; policy?: Policy }): Promise<VerifiedResult<bigint>>
  readStorage(args: { address: string; slot: string; policy?: Policy }): Promise<VerifiedResult<Hex>>
  readNonce(args: { address: string; policy?: Policy }): Promise<VerifiedResult<bigint>>
  readCode(args: { address: string; policy?: Policy }): Promise<VerifiedResult<Hex>>
}

type Kind = 'balance' | 'nonce' | 'storage' | 'code'

/** Same rule as the engine (crates/router/src/probe.rs `valid_provider_name`). */
const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/
/** How often one provider may re-fetch because the finalized block moved under it. */
const MAX_ROOT_REFRESHES = 1
/** Upstream error text is cut to this length after secrets are removed. */
const MAX_DETAIL = 160
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** While the two light clients are at different finalized blocks, ask again this often. */
const ALIGN_POLL_MS = 1_500
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const MECHANISMS: Record<Kind, TrustReceipt['verification']['mechanisms']> = {
  balance: ['account-proof'],
  nonce: ['account-proof'],
  storage: ['account-proof', 'storage-proof'],
  code: ['account-proof', 'code-hash'],
}

/** JSON-RPC or transport error from the provider. The message is already sanitised. */
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message)
  }
}

const invalid = (message: string) => new InvalidRequestError(ERROR_CODES.INVALID_REQUEST, message)

function validateOptions(opts: PrivateReaderOptions): void {
  if (!Array.isArray(opts.providers) || opts.providers.length === 0) {
    throw invalid('createPrivateReader needs at least one provider')
  }
  if (typeof opts.network !== 'string' || !LABEL_RE.test(opts.network)) {
    throw invalid("network must be 1-64 letters, digits, '_', '-' or '.'")
  }
  const seen = new Set<string>()
  opts.providers.forEach((provider, index) => {
    // A bad label is never echoed: it could be a URL or a key pasted in the wrong field.
    if (typeof provider.label !== 'string' || !LABEL_RE.test(provider.label)) {
      throw invalid(`providers[${index}].label must be 1-64 letters, digits, '_', '-' or '.'`)
    }
    if (seen.has(provider.label)) throw invalid(`provider label "${provider.label}" is used twice`)
    seen.add(provider.label)
    let url: URL
    try {
      url = new URL(provider.url)
    } catch {
      throw invalid(`provider "${provider.label}": url is not a valid URL`)
    }
    const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    if (url.protocol !== 'https:' && !(opts.allowInsecureLoopback && loopbackHttp)) {
      throw invalid(`provider "${provider.label}": url must be https`)
    }
  })
}

/** Pieces of each provider URL that may carry a key: the URL, its path segments, query values, credentials. */
function secretsOf(providers: PrivateProvider[]): string[] {
  const secrets = new Set<string>()
  for (const { url } of providers) {
    secrets.add(url)
    try {
      const u = new URL(url)
      secrets.add(`${u.origin}${u.pathname}`)
      for (const part of u.pathname.split('/')) if (part.length >= 8) secrets.add(part)
      for (const value of u.searchParams.values()) if (value.length >= 8) secrets.add(value)
      if (u.username) secrets.add(u.username)
      if (u.password) secrets.add(u.password)
    } catch {
      // validateOptions already rejected it
    }
  }
  // Longest first, so a URL is replaced before the key inside it.
  return [...secrets].sort((a, b) => b.length - a.length)
}

/** Upstream text with provider URLs, keys and any other URL removed, then truncated. */
function sanitize(message: string, secrets: string[]): string {
  let out = message
  for (const secret of secrets) out = out.split(secret).join('<redacted>')
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL)}…` : out
}

/** The provider did not like the block (hash form, or does not have it yet): try by number. */
function blockRefused(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false
  return err.code === -32602 || err.code === -32000 || /unknown block|header not found|block not found/i.test(err.message)
}

/** The browser and the engine proved the same value (words compared as numbers). */
function sameValue(kind: Kind, a: string, b: string): boolean {
  if (kind === 'code') return a.toLowerCase() === b.toLowerCase()
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

/** The finalized block moved between getRoot and verifyProof (rpc.rs adds this hint). */
function rootMoved(err: unknown): boolean {
  return err instanceof InvalidRequestError && /veriq_getRoot/.test(err.message)
}

export function createPrivateReader(client: VeriqClient, opts: PrivateReaderOptions): PrivateReader {
  validateOptions(opts)
  const timeoutMs = opts.timeoutMs ?? 30_000
  const providers = opts.providers.map((p) => ({ ...p }))
  const secrets = secretsOf(providers)
  const alignTimeoutMs = opts.alignTimeoutMs ?? 30_000

  /** The light client's answer; an error or a malformed block counts as "not synced". */
  async function browserFinalized(lightClient: BrowserLightClient): Promise<BrowserRoot | null> {
    let root: BrowserRoot | null
    try {
      root = await lightClient.finalized()
    } catch {
      return null
    }
    if (!root) return null
    if (!Number.isSafeInteger(root.number) || !HASH_RE.test(root.hash) || !HASH_RE.test(root.stateRoot)) return null
    return { number: root.number, hash: root.hash, stateRoot: root.stateRoot }
  }

  /** The browser verifier, loaded once; `null` with the reason if it did not load. */
  let verifierState: Promise<{ verifier: BrowserVerifier } | { unavailable: string }> | null = null
  function browserVerifier() {
    const source = opts.verifier
    if (!source) return Promise.resolve(null)
    verifierState ??= (async () => {
      try {
        return { verifier: typeof source === 'function' ? await source() : source }
      } catch (err) {
        return { unavailable: err instanceof Error ? err.message : String(err) }
      }
    })()
    return verifierState
  }

  /**
   * The block to fetch at. With a synced browser light client, both roots must name the same
   * block; if they are at different heights, wait (bounded) for the slower one to catch up.
   * `engineDown`: the engine is unreachable, and the browser light client and verifier can
   * carry the read alone.
   */
  async function pinRoot(canRunLocally: boolean): Promise<{ root: RootInfo; browser?: BrowserRoot; engineDown?: true }> {
    const lightClient = opts.lightClient
    if (!lightClient) return { root: await client.getRoot() }
    const deadline = Date.now() + alignTimeoutMs
    for (;;) {
      const [engine, browser] = await Promise.all([
        client.getRoot().then(
          (root) => ({ root }),
          (error: unknown) => ({ error }),
        ),
        browserFinalized(lightClient),
      ])
      if ('error' in engine) {
        if (engine.error instanceof EngineUnreachableError && browser && canRunLocally) {
          return { root: { ...browser, rootSource: 'local-light-client', verified: true }, browser, engineDown: true }
        }
        throw engine.error
      }
      const root = engine.root
      if (!browser) return { root }
      if (browser.number === root.number) {
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
        if (!same(browser.hash, root.hash) || !same(browser.stateRoot, root.stateRoot)) {
          throw new RootMismatchError(
            ERROR_CODES.ROOT_MISMATCH,
            `finalized block #${root.number}: the browser light client has ${browser.hash} (state root ` +
              `${browser.stateRoot}), the engine has ${root.hash} (state root ${root.stateRoot}); nothing was read`,
          )
        }
        return { root, browser }
      }
      if (Date.now() >= deadline) {
        throw new RootUnavailableError(
          ERROR_CODES.ROOT_UNAVAILABLE,
          `the browser light client is at finalized block #${browser.number} and the engine at #${root.number}; ` +
            `they did not agree within ${Math.round(alignTimeoutMs / 1000)} s`,
          { hint: 'One light client is not following finality. Check the engine /health and the browser light client status.' },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, ALIGN_POLL_MS))
    }
  }

  /** Providers that rejected the EIP-1898 `{ blockHash }` form (-32602): ask them by number. */
  const numberOnly = new Set<string>()
  let nextId = 1

  async function upstream(provider: PrivateProvider, method: string, params: unknown[]): Promise<unknown> {
    const id = nextId++
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new UpstreamError(`no answer within ${timeoutMs} ms`, undefined))
      }, timeoutMs)
    })
    const call = (async () => {
      let res: Response
      let body: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
      try {
        res = await opts.fetch(provider.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        })
        body = (await res.json()) as typeof body
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        throw new UpstreamError(sanitize(text || 'request failed', secrets), undefined)
      }
      if (body && typeof body === 'object' && body.error) {
        const message = typeof body.error.message === 'string' ? body.error.message : 'provider error'
        const code = typeof body.error.code === 'number' ? body.error.code : undefined
        throw new UpstreamError(sanitize(message, secrets), code)
      }
      if (!body || typeof body !== 'object' || !('result' in body)) {
        throw new UpstreamError(`HTTP ${res.status} without a JSON-RPC result`, undefined)
      }
      if (body.id !== id) throw new UpstreamError('JSON-RPC answer has the wrong id', undefined)
      return body.result
    })()
    try {
      return await Promise.race([call, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * `method(...params, block)` at exactly the pinned block: by hash (EIP-1898) first, then by
   * number. A provider that rejects the hash form (-32602) is asked by number from then on; one
   * that does not have the block yet (-32000, "unknown block") is not remembered.
   */
  async function atBlock(provider: PrivateProvider, method: string, params: unknown[], root: RootInfo) {
    if (!numberOnly.has(provider.label)) {
      try {
        return await upstream(provider, method, [...params, { blockHash: root.hash }])
      } catch (err) {
        if (!blockRefused(err)) throw err
        if ((err as UpstreamError).code === -32602) numberOnly.add(provider.label)
      }
    }
    return upstream(provider, method, [...params, `0x${root.number.toString(16)}`])
  }

  async function read(kind: Kind, address: string, slot: string | undefined, policy: Policy | undefined) {
    assertAddress(address)
    if (kind === 'storage') {
      if (slot === undefined) throw invalid('readStorage needs a slot')
      assertSlot(slot)
    }
    const local = await browserVerifier()
    const verifier = local && 'verifier' in local ? local.verifier : null
    /** Every provider tried, for a receipt made in the browser. */
    const attempts: TrustReceipt['routing']['attempts'] = []
    const attemptLabel = (p: PrivateProvider) => `${p.label}@anon-rpc:${opts.network}`
    let lastError: unknown
    for (const provider of providers) {
      // Per provider: a moving finalized block may make it fetch again, up to the budget.
      for (let refreshes = 0; ; refreshes++) {
        // engine/root errors stop the read
        const { root, browser, engineDown } = await pinRoot(verifier !== null)
        const started = Date.now()
        let proof: unknown
        let code: unknown
        try {
          proof = await atBlock(provider, 'eth_getProof', [address, slot === undefined ? [] : [slot]], root)
          if (kind === 'code') code = await atBlock(provider, 'eth_getCode', [address], root)
        } catch (err) {
          lastError = err
          attempts.push({ provider: attemptLabel(provider), outcome: 'transport-failure', elapsedMs: Date.now() - started, failureReason: 'provider request failed' })
          break // transport or provider failure: next provider
        }

        // S5: the browser checks the proof against the same root before the engine sees it.
        let localValue: string | null = null
        if (verifier) {
          const outcome = verifier.verifyRead({ stateRoot: root.stateRoot, address, kind, ...(slot === undefined ? {} : { slot }), proof, ...(kind === 'code' ? { code } : {}) })
          if (!outcome.ok) {
            if (outcome.code === 'INVALID_PROOF') {
              lastError = new InvalidProofError(ERROR_CODES.INVALID_PROOF, `${provider.label}: rejected in the browser, the engine was not asked: ${outcome.error}`)
              attempts.push({ provider: attemptLabel(provider), outcome: 'invalid-proof', elapsedMs: Date.now() - started, failureReason: 'INVALID_PROOF: provider attempt failed' })
              break // a lying provider: next one
            }
            throw new InvalidRequestError(ERROR_CODES.INVALID_REQUEST, `the browser verifier refused the read: ${outcome.error}`)
          }
          localValue = outcome.value
        }
        const elapsedMs = Date.now() - started
        const input = {
          kind,
          address,
          ...(slot === undefined ? {} : { slot }),
          blockHash: root.hash,
          proof,
          ...(kind === 'code' ? { code } : {}),
          provider: provider.label,
          network: opts.network,
          elapsedMs,
          ...(browser ? { browserRoot: browser } : {}),
          ...(verifier ? { verifier: 'browser' as const } : opts.verifier ? { verifier: 'unavailable' as const } : {}),
        }
        const localOnly = () => {
          attempts.push({ provider: attemptLabel(provider), outcome: 'success', elapsedMs })
          return localResult(verifier!, input, localValue!, root, attempts, policy)
        }
        if (engineDown) return localOnly()
        try {
          const result = await client.verifyProof(input, policy)
          if (localValue !== null && !sameValue(kind, localValue, result.value)) {
            throw new InternalError(
              ERROR_CODES.INTERNAL_ERROR,
              'the browser verifier and the engine proved different values from the same proof; nothing was returned',
            )
          }
          return result
        } catch (err) {
          if (err instanceof EngineUnreachableError && localValue !== null && browser) return localOnly()
          lastError = err
          if (err instanceof InvalidProofError) {
            attempts.push({ provider: attemptLabel(provider), outcome: 'invalid-proof', elapsedMs, failureReason: 'INVALID_PROOF: provider attempt failed' })
          }
          if (rootMoved(err)) {
            if (refreshes < MAX_ROOT_REFRESHES) continue // same provider, new root
            // Another provider would race the same moving block; stop and say why.
            throw new InvalidRequestError(
              ERROR_CODES.INVALID_REQUEST,
              `the finalized block moved again while fetching through ${opts.network}; nothing was verified`,
              { cause: err, hint: 'Retry the read. The provider or network is slower than the finalized block moves.' },
            )
          }
          if (err instanceof InvalidProofError) break // a lying provider: next one
          throw err // policy, root, engine: not a provider problem
        }
      }
    }
    if (lastError instanceof VeriqError) throw lastError
    const detail = lastError instanceof Error ? lastError.message : 'no answer'
    throw new AllProvidersFailedError(
      ERROR_CODES.ALL_PROVIDERS_FAILED,
      `no provider answered through ${opts.network} (${providers.length} tried): ${detail}`,
      { hint: 'The anonymizing network may still be connecting, or the providers refuse browser requests (CORS).' },
    )
  }

  /**
   * A read verified entirely in this browser: its light client's root, its verifier, no engine.
   * Same receipt shape as the engine's; bindings computed by the same Rust code.
   */
  function localResult(
    verifier: BrowserVerifier,
    input: Record<string, unknown> & { provider: string },
    value: string,
    root: RootInfo,
    attempts: TrustReceipt['routing']['attempts'],
    policy: Policy | undefined,
  ): VerifiedResult<Hex> {
    const method = 'veriq_verifyProof'
    const params = policy ? [input, policy] : [input]
    const warnings = [
      {
        code: 'LOCAL_ONLY',
        message: `the engine could not be reached: this value was verified in the browser against its own light client (synced over ${opts.network}); the engine did not see or store this receipt`,
      },
      {
        code: 'BROWSER_LIGHT_CLIENT',
        message: `a light client in the browser, synced over ${opts.network}, produced this finalized block and state root`,
      },
    ]
    if (policy?.consistency === 'compare') {
      warnings.push({ code: 'COMPARE_UNAVAILABLE', message: 'a client-fetched proof comes from one provider; nothing was compared' })
    }
    const now = Math.floor(Date.now() / 1000)
    const receipt = TrustReceiptSchema.parse({
      identity: {
        requestId: `local-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`,
        method,
        requestBinding: verifier.binding(method, params),
        resultBinding: verifier.binding(method, value),
      },
      block: { number: root.number, hash: root.hash, stateRoot: root.stateRoot, finalized: true },
      verification: {
        status: 'verified',
        rootSource: 'local-light-client',
        verifierLocation: 'browser',
        mechanisms: MECHANISMS[input.kind as Kind],
        bootstrap: { source: 'browser-light-client', checkpoint: null, checkpointSource: null },
      },
      privacy: { transport: 'anon-rpc', mechanism: opts.network },
      routing: { comparison: 'not-run', providersTried: attempts.length, providerLabel: `${input.provider}@anon-rpc:${opts.network}`, attempts },
      freshness: { observedAt: now, ageSeconds: 0, pinned: true },
      warnings,
    })
    return { value: value as Hex, receipt, verified: true, attempts: attemptsFromReceipt(receipt) }
  }

  const word = (r: VerifiedResult<Hex>): VerifiedResult<bigint> => ({ ...r, value: BigInt(r.value) })
  return {
    readBalance: async ({ address, policy }) => word(await read('balance', address, undefined, policy)),
    readNonce: async ({ address, policy }) => word(await read('nonce', address, undefined, policy)),
    readStorage: async ({ address, slot, policy }) => {
      const r = await read('storage', address, slot, policy)
      return { ...r, value: `0x${BigInt(r.value).toString(16).padStart(64, '0')}` as Hex }
    },
    readCode: ({ address, policy }) => read('code', address, undefined, policy),
  }
}
