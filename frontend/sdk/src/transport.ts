// Type-only viem import: the transport has no runtime dependency on viem.
import type { EIP1193RequestFn, Transport } from 'viem'
import { ERROR_CODES, UnsupportedVerificationError } from './errors'
import type { VeriqClient } from './client'
import type { Policy, TrustReceipt } from './types'

export interface VeriqTransportOptions {
  /** Policy for verified reads. Default: the client's policy. */
  policy?: Policy
  /**
   * Reject block tags other than "finalized" before sending.
   * Default: true when the policy requires verification.
   */
  strict?: boolean
  /** Called with every receipt from a verified read, including eth_getTransactionCount and eth_getCode. */
  onReceipt?: (receipt: TrustReceipt) => void
}

/** A viem Transport that also exposes the latest receipt. */
export type VeriqTransport = Transport<'veriq'> & { readonly lastReceipt: TrustReceipt | undefined }

type Params = readonly unknown[] | undefined

function blockTag(params: Params, index: number): unknown {
  return params?.[index] ?? 'latest'
}

/**
 * Build a viem custom transport backed by a Veriq client.
 * @example
 * const transport = veriq.transport({ onReceipt: (r) => console.log(r.block.number) })
 * const client = createPublicClient({ chain: sepolia, transport })
 * await client.getBalance({ address, blockTag: 'finalized' })
 * transport.lastReceipt?.verification.status // 'verified'
 */
export function createTransport(client: VeriqClient, opts: VeriqTransportOptions = {}): VeriqTransport {
  const policy = opts.policy ?? client.policy
  const strict = opts.strict ?? policy.verification === 'required'
  let last: TrustReceipt | undefined

  const record = (r: TrustReceipt) => {
    last = r
    opts.onReceipt?.(r)
  }

  const verifiedPath = (method: string, tag: unknown) => {
    if (tag === 'finalized') return true
    if (strict) {
      throw new UnsupportedVerificationError(
        ERROR_CODES.UNSUPPORTED_VERIFICATION,
        `${method} at block "${typeof tag === 'string' ? tag : 'custom'}" can't be proven; only "finalized" can`,
        { hint: "Pass blockTag: 'finalized' (viem defaults to 'latest')." },
      )
    }
    return false
  }

  async function request({ method, params }: { method: string; params?: Params }): Promise<unknown> {
    if (method === 'eth_getBalance' && verifiedPath(method, blockTag(params, 1))) {
      const r = await client.readBalance({ address: String(params?.[0]), policy })
      record(r.receipt)
      return `0x${r.value.toString(16)}`
    }
    if (method === 'eth_getStorageAt' && verifiedPath(method, blockTag(params, 2))) {
      const r = await client.readStorage({ address: String(params?.[0]), slot: String(params?.[1]), policy })
      record(r.receipt)
      return r.value
    }
    // Proven by the engine too; their receipt arrives in the top-level `veriq` member.
    if ((method === 'eth_getTransactionCount' || method === 'eth_getCode') && verifiedPath(method, blockTag(params, 1))) {
      const { result, receipt } = await client.requestWithReceipt(method, params ? [...params] : [])
      if (receipt) record(receipt)
      return result
    }
    // Everything else goes to the engine unchanged; it decides what it can serve.
    // Keep a receipt if the engine attached one.
    const { result, receipt } = await client.requestWithReceipt(method, params ? [...params] : [])
    if (receipt) record(receipt)
    return result
  }

  const eip1193 = request as unknown as EIP1193RequestFn
  const transport = (() => ({
    config: { key: 'veriq', name: 'Veriq', request: eip1193, retryCount: 0, type: 'veriq' as const },
    request: eip1193,
    value: {
      get lastReceipt() {
        return last
      },
    },
  })) as Transport<'veriq'>

  Object.defineProperty(transport, 'lastReceipt', { get: () => last, enumerable: true })
  return transport as VeriqTransport
}
