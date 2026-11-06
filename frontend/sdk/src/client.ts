import { z } from 'zod'
import { ERROR_CODES, InvalidRequestError } from './errors'
import { verifiedFinalized } from './presets'
import { httpGet, parseWith, rpcCall, rpcEnvelope, type RpcContext } from './rpc'
import {
  CapabilitiesSchema,
  EngineHealthSchema,
  PolicySchema,
  ProviderHealthSchema,
  ReadResultSchema,
  ReceiptListSchema,
  OUTCOME_LABEL,
  ReceiptRecordSchema,
  RootInfoSchema,
  TrustReceiptSchema,
  DelegationResultSchema,
  formatIssues,
} from './schema'
import { createTransport, type VeriqTransport, type VeriqTransportOptions } from './transport'
import type {
  Address,
  Attempt,
  Capabilities,
  EngineHealth,
  Hex,
  Policy,
  ProviderHealth,
  ReceiptRecord,
  TrustReceipt,
  VerifiedResult,
  DelegationResult,
} from './types'

/** Default engine URL. The engine only binds to localhost. */
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8547'

export interface VeriqOptions {
  /** Engine URL. Default http://127.0.0.1:8547 */
  url?: string
  /** Default policy for reads. Default `verifiedFinalized`. */
  policy?: Policy
  /** Custom fetch (tests, proxies). Default: global fetch. */
  fetch?: typeof fetch
  /** Client-side timeout. Default: policy.timeoutMs + 1 s for reads, 5 s for health/receipts. */
  timeoutMs?: number
  /** Log method names and timings with console.debug. Never logs addresses or params. */
  debug?: boolean
}

export interface ReadOptions {
  policy?: Policy
  signal?: AbortSignal
}

/** A Veriq client. Immutable: `withPolicy` returns a new one. */
export interface VeriqClient {
  readonly url: string
  readonly policy: Policy
  /**
   * Proven ETH balance (wei) at the pinned finalized block.
   * @example const { value, verified } = await veriq.readBalance({ address: '0x…' })
   */
  readBalance(args: { address: string } & ReadOptions): Promise<VerifiedResult<bigint>>
  /**
   * Proven storage slot value as 32-byte hex.
   * @example const { value } = await veriq.readStorage({ address, slot: '0x0' })
   */
  readStorage(args: { address: string; slot: string } & ReadOptions): Promise<VerifiedResult<Hex>>
  /**
   * Proven EIP-7702 delegation detection result and Trust Receipt.
   * @example const res = await veriq.getDelegation({ address: '0x…' })
   */
  getDelegation(args: { address: string } & ReadOptions): Promise<DelegationResult>
  /**
   * A stored Trust Receipt by request id (veriq_getReceipt).
   * @example const receipt = await veriq.getReceipt(result.receipt.identity.requestId)
   */
  getReceipt(id: string): Promise<TrustReceipt>
  /**
   * The full stored row (value, attempts, error) from GET /receipts/:id.
   * @example const row = await veriq.getReceiptRecord(id)
   */
  getReceiptRecord(id: string): Promise<ReceiptRecord>
  /**
   * Newest receipts first (GET /receipts?limit=).
   * @example const rows = await veriq.listReceipts(50)
   */
  listReceipts(limit?: number): Promise<ReceiptRecord[]>
  /**
   * Engine, light client and provider health (GET /health).
   * @example const { lightClient } = await veriq.health()
   */
  health(): Promise<EngineHealth>
  /**
   * Per-provider capabilities and breaker state (veriq_getProviderHealth).
   * @example const providers = await veriq.providers()
   */
  providers(): Promise<ProviderHealth[]>
  /**
   * Which methods and policies the engine can satisfy (veriq_getCapabilities).
   * @example const { verifiedMethods } = await veriq.capabilities()
   */
  capabilities(): Promise<Capabilities>
  /**
   * The finalized block the engine verifies against (veriq_getRoot). A client that fetches
   * its own proofs (Anon-RPC) asks the provider for exactly this block.
   * @example const { number, hash } = await veriq.getRoot()
   */
  getRoot(): Promise<RootInfo>
  /**
   * Verify an eth_getProof result the client fetched itself (veriq_verifyProof). Used by
   * `createPrivateReader`; the engine checks it against its own pinned root.
   */
  verifyProof(input: ClientProofInput, policy?: Policy): Promise<VerifiedResult<Hex>>
  /**
   * viem transport. eth_getBalance / eth_getStorageAt go through the verified path; every receipt lands in lastReceipt.
   * @example createPublicClient({ chain: sepolia, transport: veriq.transport() })
   */
  transport(opts?: VeriqTransportOptions): VeriqTransport
  /**
   * New client with a different default policy.
   * @example const strict = veriq.withPolicy(verifiedCompare)
   */
  withPolicy(policy: Policy): VeriqClient
  /**
   * Raw JSON-RPC call to the engine.
   * @example await veriq.request('eth_chainId')
   */
  request(method: string, params?: unknown[]): Promise<unknown>
  /**
   * Raw JSON-RPC call that also returns the Trust Receipt the engine attaches to
   * verified standard reads (eth_getBalance, eth_getStorageAt, eth_getTransactionCount,
   * eth_getCode at "finalized"). `receipt` is undefined for methods that carry none.
   * @example const { result, receipt } = await veriq.requestWithReceipt('eth_getCode', [address, 'finalized'])
   */
  requestWithReceipt(method: string, params?: unknown[]): Promise<RawResult>
}

/** veriq_getRoot result. */
export type RootInfo = z.output<typeof RootInfoSchema>

/** veriq_verifyProof input: a proof the client fetched (through Anon-RPC) at `blockHash`. */
export interface ClientProofInput {
  kind: 'balance' | 'nonce' | 'storage' | 'code'
  address: string
  slot?: string
  /** The block from `getRoot()` the proof was fetched for. */
  blockHash: string
  /** The raw eth_getProof result. */
  proof: unknown
  /** The raw eth_getCode result (kind `code`). */
  code?: unknown
  /** Provider label (never a URL). */
  provider: string
  /** Anonymizing network, e.g. `nox`. */
  network: string
  elapsedMs?: number
  /**
   * The same finalized block, as a light client in the browser reported it (S4.2). The engine
   * refuses the proof with ROOT_MISMATCH unless it is exactly its own pinned block.
   */
  browserRoot?: BrowserRoot
  /**
   * S5: `browser` when the client checked this proof itself first (the engine checks it again and
   * marks the receipt `verifierLocation: "browser"`); `unavailable` when its verifier did not load.
   */
  verifier?: 'browser' | 'unavailable'
}

/** A finalized block from a light client running in the browser (e.g. Helios over Nox). */
export interface BrowserRoot {
  number: number
  hash: string
  stateRoot: string
}

/** `requestWithReceipt` result: the JSON-RPC `result` and the validated receipt, if any. */
export interface RawResult {
  result: unknown
  receipt: TrustReceipt | undefined
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const SLOT_RE = /^0x[0-9a-fA-F]{1,64}$/

/** Receipt attempts (receipt.rs) in the display form used by VerifiedResult and the components. */
export function attemptsFromReceipt(receipt: TrustReceipt): Attempt[] {
  return receipt.routing.attempts.map((a) => ({
    provider: a.provider,
    outcome: OUTCOME_LABEL[a.outcome] ?? a.outcome,
    elapsedMs: a.elapsedMs,
    ...(a.failureReason ? { reason: a.failureReason } : {}),
  }))
}

function invalid(message: string): InvalidRequestError {
  return new InvalidRequestError(ERROR_CODES.INVALID_REQUEST, message)
}

/** Throws InvalidRequestError (no network call) for a malformed address. */
export function assertAddress(address: string): asserts address is Address {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    throw invalid('address must be 0x followed by 40 hex characters')
  }
}

/** Throws InvalidRequestError (no network call) for a malformed slot. */
export function assertSlot(slot: string): asserts slot is Hex {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw invalid('slot must be 0x followed by 1 to 64 hex characters')
}

/**
 * Same field rules as the engine. Deliberately does NOT reject latest + required:
 * the engine answers POLICY_UNSATISFIABLE, so apps can show the real reason.
 */
export function assertPolicy(policy: Policy): void {
  const res = PolicySchema.safeParse(policy)
  if (!res.success) throw invalid(formatIssues(res.error, policy, 'policy').join('; '))
}

/**
 * Create a Veriq client.
 * @example
 * import { createVeriq } from 'veriq-client'
 * const veriq = createVeriq()
 * const { value, verified } = await veriq.readBalance({ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' })
 */
export function createVeriq(options: VeriqOptions = {}): VeriqClient {
  const url = (options.url ?? DEFAULT_ENGINE_URL).replace(/\/$/, '')
  const policy = options.policy ?? verifiedFinalized
  assertPolicy(policy)
  const fetchFn = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const ctx: RpcContext = { url, fetch: fetchFn, debug: options.debug ?? false }
  const readTimeout = (p: Policy) => options.timeoutMs ?? p.timeoutMs + 1000
  const shortTimeout = { timeoutMs: options.timeoutMs ?? 5000 }

  async function read(method: string, params: unknown[], p: Policy, signal?: AbortSignal) {
    assertPolicy(p)
    const raw = await rpcCall(ctx, method, [...params, p], { timeoutMs: readTimeout(p), ...(signal ? { signal } : {}) })
    const r = parseWith(ReadResultSchema, raw, 'result')
    // Prefer an explicit attempts list; otherwise use the ones recorded in the receipt.
    return { ...r, attempts: r.attempts.length ? r.attempts : attemptsFromReceipt(r.receipt) }
  }

  const client: VeriqClient = {
    url,
    policy,
    async readBalance({ address, policy: p = policy, signal }) {
      assertAddress(address)
      const r = await read('veriq_readBalance', [address], p, signal)
      return { value: BigInt(r.value), receipt: r.receipt, verified: r.receipt.verification.status === 'verified', attempts: r.attempts }
    },
    async readStorage({ address, slot, policy: p = policy, signal }) {
      assertAddress(address)
      assertSlot(slot)
      const r = await read('veriq_readStorage', [address, slot], p, signal)
      const value = `0x${BigInt(r.value).toString(16).padStart(64, '0')}` as Hex
      return { value, receipt: r.receipt, verified: r.receipt.verification.status === 'verified', attempts: r.attempts }
    },
    async getDelegation({ address, policy: p = policy, signal }) {
      assertAddress(address)
      assertPolicy(p)
      const raw = await rpcCall(ctx, 'veriq_getDelegation', [address, p], { timeoutMs: readTimeout(p), ...(signal ? { signal } : {}) })
      return parseWith(DelegationResultSchema, raw, 'delegation')
    },
    async getReceipt(id) {
      const raw = await rpcCall(ctx, 'veriq_getReceipt', [id], shortTimeout)
      // The engine may answer with the bare receipt or with a stored row around it.
      const receipt = raw && typeof raw === 'object' && 'receipt' in raw && !('identity' in raw) ? raw.receipt : raw
      return parseWith(TrustReceiptSchema, receipt, 'receipt')
    },
    async getReceiptRecord(id) {
      return parseWith(ReceiptRecordSchema, await httpGet(ctx, `/receipts/${encodeURIComponent(id)}`, shortTimeout), 'record')
    },
    async listReceipts(limit = 50) {
      return parseWith(ReceiptListSchema, await httpGet(ctx, `/receipts?limit=${limit}`, shortTimeout), 'receipts').receipts
    },
    async health() {
      return parseWith(EngineHealthSchema, await httpGet(ctx, '/health', shortTimeout), 'health')
    },
    async providers() {
      const raw = await rpcCall(ctx, 'veriq_getProviderHealth', [], shortTimeout)
      const list = raw && typeof raw === 'object' && 'providers' in raw ? raw.providers : raw
      return parseWith(z.array(ProviderHealthSchema), list, 'providers')
    },
    async getRoot() {
      return parseWith(RootInfoSchema, await rpcCall(ctx, 'veriq_getRoot', [], shortTimeout), 'root')
    },
    async verifyProof(input, p = policy) {
      assertPolicy(p)
      assertAddress(input.address)
      if (input.kind === 'storage') {
        if (input.slot === undefined) throw invalid('a storage proof needs a slot')
        assertSlot(input.slot)
      }
      // A new object: the caller's input is never changed. `slot` is sent only for storage.
      const { slot, elapsedMs, ...rest } = input
      const payload = {
        ...rest,
        ...(input.kind === 'storage' ? { slot } : {}),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      }
      const raw = await rpcCall(ctx, 'veriq_verifyProof', [payload, p], { timeoutMs: readTimeout(p) })
      const r = parseWith(ReadResultSchema, raw, 'result')
      return { value: r.value as Hex, receipt: r.receipt, verified: r.receipt.verification.status === 'verified', attempts: attemptsFromReceipt(r.receipt) }
    },
    async capabilities() {
      return parseWith(CapabilitiesSchema, await rpcCall(ctx, 'veriq_getCapabilities', [], shortTimeout), 'capabilities')
    },
    transport: (opts) => createTransport(client, opts),
    withPolicy: (p) => createVeriq({ ...options, policy: p }),
    request: (method, params = []) => rpcCall(ctx, method, params, { timeoutMs: readTimeout(policy) }),
    async requestWithReceipt(method, params = []) {
      const { result, veriq } = await rpcEnvelope(ctx, method, params, { timeoutMs: readTimeout(policy) })
      // Same contract as veriq_* reads: a receipt that does not match the schema is an error, never dropped.
      return { result, receipt: veriq === undefined ? undefined : parseWith(TrustReceiptSchema, veriq, 'veriq') }
    },
  }
  return Object.freeze(client)
}
