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
import type { VeriqClient } from './client'
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
  /** Network name recorded in the receipt (`privacy.mechanism`), e.g. `'nox'`. */
  network: string
  /** Tried in order; the next one is used when a provider fails or sends a bad proof. */
  providers: PrivateProvider[]
  /** Per provider request. Default 30 s (mixnets add per-hop delay). */
  timeoutMs?: number
}

export interface PrivateReader {
  readBalance(args: { address: string; policy?: Policy }): Promise<VerifiedResult<bigint>>
  readStorage(args: { address: string; slot: string; policy?: Policy }): Promise<VerifiedResult<Hex>>
  readNonce(args: { address: string; policy?: Policy }): Promise<VerifiedResult<bigint>>
  readCode(args: { address: string; policy?: Policy }): Promise<VerifiedResult<Hex>>
}

type Kind = 'balance' | 'nonce' | 'storage' | 'code'

/** JSON-RPC error from the provider, as seen through the anonymizing fetch. */
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message)
  }
}

export function createPrivateReader(client: VeriqClient, opts: PrivateReaderOptions): PrivateReader {
  if (!opts.providers.length) throw new InvalidRequestError(ERROR_CODES.INVALID_REQUEST, 'createPrivateReader needs at least one provider')
  const timeoutMs = opts.timeoutMs ?? 30_000

  async function upstream(url: string, method: string, params: unknown[]): Promise<unknown> {
    const call = opts
      .fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      .then(async (res) => {
        const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } }
        if (body.error) throw new UpstreamError(body.error.message ?? 'provider error', body.error.code)
        if (!('result' in body)) throw new UpstreamError(`HTTP ${res.status} without a JSON-RPC result`, undefined)
        return body.result
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError(`no answer within ${timeoutMs} ms`, undefined)), timeoutMs)
    })
    try {
      return await Promise.race([call, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The exact finalized block by hash (EIP-1898); a provider that refuses (-32602) gets the same block by number. */
  async function fetchProof(url: string, address: string, slots: string[], root: { number: number; hash: string }) {
    try {
      return await upstream(url, 'eth_getProof', [address, slots, { blockHash: root.hash }])
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.code !== -32602) throw err
      return upstream(url, 'eth_getProof', [address, slots, `0x${root.number.toString(16)}`])
    }
  }

  async function read(kind: Kind, address: string, slot: string | undefined, policy: Policy | undefined) {
    assertAddress(address)
    if (slot !== undefined) assertSlot(slot)
    let lastError: unknown
    let rootRetried = false
    for (let i = 0; i < opts.providers.length; i++) {
      const provider = opts.providers[i]!
      const root = await client.getRoot()
      const started = Date.now()
      let proof: unknown
      let code: unknown
      try {
        proof = await fetchProof(provider.url, address, slot === undefined ? [] : [slot], root)
        if (kind === 'code') code = await upstream(provider.url, 'eth_getCode', [address, `0x${root.number.toString(16)}`])
      } catch (err) {
        lastError = err
        continue // transport or provider failure: next provider
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
        // The finalized block moved between getRoot and verify: fetch again from the same provider, once.
        if (err instanceof InvalidRequestError && /veriq_getRoot/.test(err.message) && !rootRetried) {
          rootRetried = true
          i--
          continue
        }
        if (err instanceof InvalidProofError) continue // a lying provider: next one
        throw err // policy, root unavailable, engine unreachable: not a provider problem
      }
    }
    if (lastError instanceof InvalidProofError) throw lastError
    if (lastError instanceof VeriqError) throw lastError
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new AllProvidersFailedError(
      ERROR_CODES.ALL_PROVIDERS_FAILED,
      `no provider answered through ${opts.network} (${opts.providers.length} tried): ${detail}`,
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
