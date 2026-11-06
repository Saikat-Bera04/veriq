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
import type { RootInfo, VeriqClient } from './client'
import { assertAddress, assertSlot } from './client'
import {
  ERROR_CODES,
  AllProvidersFailedError,
  InvalidProofError,
  InvalidRequestError,
  VeriqError,
} from './errors'
import type { Hex, Policy, VerifiedResult } from './types'

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
const MAX_ROOT_REFRESHES = 2
/** Upstream error text is cut to this length after secrets are removed. */
const MAX_DETAIL = 160
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

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

/** The finalized block moved between getRoot and verifyProof (rpc.rs adds this hint). */
function rootMoved(err: unknown): boolean {
  return err instanceof InvalidRequestError && /veriq_getRoot/.test(err.message)
}

export function createPrivateReader(client: VeriqClient, opts: PrivateReaderOptions): PrivateReader {
  validateOptions(opts)
  const timeoutMs = opts.timeoutMs ?? 30_000
  const providers = opts.providers.map((p) => ({ ...p }))
  const secrets = secretsOf(providers)
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
    let lastError: unknown
    for (const provider of providers) {
      // Per provider: a moving finalized block may make it fetch again, up to the budget.
      for (let refreshes = 0; ; refreshes++) {
        const root = await client.getRoot() // engine/root errors stop the read
        const started = Date.now()
        let proof: unknown
        let code: unknown
        try {
          proof = await atBlock(provider, 'eth_getProof', [address, slot === undefined ? [] : [slot]], root)
          if (kind === 'code') code = await atBlock(provider, 'eth_getCode', [address], root)
        } catch (err) {
          lastError = err
          break // transport or provider failure: next provider
        }
        try {
          return await client.verifyProof(
            {
              kind,
              address,
              ...(slot === undefined ? {} : { slot }),
              blockHash: root.hash,
              proof,
              ...(kind === 'code' ? { code } : {}),
              provider: provider.label,
              network: opts.network,
              elapsedMs: Date.now() - started,
            },
            policy,
          )
        } catch (err) {
          lastError = err
          if (rootMoved(err) && refreshes < MAX_ROOT_REFRESHES) continue // same provider, new root
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
