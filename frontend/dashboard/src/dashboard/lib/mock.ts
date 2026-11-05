/**
 * SAMPLE DATA. Served only when the engine is unreachable, and always labelled
 * "sample data" on screen. Shapes come from the SDK's Zod schemas, and every
 * record is parsed through them so fixtures can't drift from the real contract.
 */
import {
  EngineHealthSchema,
  ReceiptRecordSchema,
  VeriqError,
  ERROR_CODES,
  type Attempt,
  type EngineHealth,
  type Policy,
  type ProviderHealth,
  type TrustReceipt,
  type ReceiptRecord,
  type VerifiedResult,
  type VerificationStatus,
} from 'veriq-client'
import { WEI_PER_ETH } from './format'

export const ATTACK_MODES = ['off', 'value', 'proof', 'wrongblock', 'outage', 'nonce', 'code'] as const
export type AttackMode = (typeof ATTACK_MODES)[number]

export const DEMO_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const DEMO_STORAGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

// ---------- deterministic pseudo-random helpers ----------
function fnv(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function rng(seed: string) {
  let a = fnv(seed)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hex(seed: string, bytes = 32): string {
  const r = rng(seed)
  let out = ''
  for (let i = 0; i < bytes * 2; i++) out += Math.floor(r() * 16).toString(16)
  return out
}
const hex0x = (seed: string, bytes = 32) => `0x${hex(seed, bytes)}`

const SAMPLE_ADDRESSES = [DEMO_ADDRESS, hex0x('addr-1', 20), hex0x('addr-2', 20), hex0x('addr-3', 20), hex0x('addr-4', 20)]

// ---------- clock ----------
const T0 = Date.now()
const BLOCK_AT_T0 = 7_123_456
const BLOCK_MS = 12_000
const blockAt = (ms: number) => BLOCK_AT_T0 + Math.floor((ms - T0) / BLOCK_MS)
const blockHash = (n: number) => hex0x(`block-${n}`)
const stateRoot = (n: number) => hex0x(`root-${n}`)

export function balanceFor(address: string): bigint {
  if (address.toLowerCase() === DEMO_ADDRESS.toLowerCase()) return 2n * WEI_PER_ETH
  const r = rng(address.toLowerCase())
  return BigInt(Math.floor(r() * 50_000)) * 10n ** 14n
}
const FORGED_BONUS = 1000n * WEI_PER_ETH

// ---------- record builder ----------
interface Build {
  at: number
  method: 'veriq_readBalance' | 'veriq_readStorage'
  address: string
  slot?: string
  value?: bigint
  attempts: Attempt[]
  status?: VerificationStatus
  finalized?: boolean
  comparison?: TrustReceipt['routing']['comparison']
  warnings?: TrustReceipt['warnings']
  error?: { code: number; message: string }
}

function build(b: Build): ReceiptRecord {
  const id = `${hex(`id-${b.at}-${b.address}`, 4)}-${hex(`id2-${b.at}`, 2)}-4${hex(`id3-${b.at}`, 2).slice(1)}-${hex(`id4-${b.at}`, 6)}`
  const n = blockAt(b.at)
  const okAttempt = [...b.attempts].reverse().find((a) => a.outcome === 'ok')
  const receipt: TrustReceipt | null = b.error
    ? null
    : {
        identity: {
          requestId: id,
          method: b.method,
          requestBinding: hex(`req-${id}`),
          resultBinding: hex(`res-${id}`),
        },
        block: { number: n, hash: blockHash(n), stateRoot: stateRoot(n), finalized: b.finalized ?? true },
        verification: {
          status: b.status ?? 'verified',
          rootSource: 'local-light-client',
          verifierLocation: 'local-engine',
          mechanisms: b.status === 'unverified' ? [] : b.slot ? ['account-proof', 'storage-proof'] : ['account-proof'],
          bootstrap: { source: 'helios', checkpoint: hex0x('checkpoint'), checkpointSource: 'config/checkpoint.toml (pinned)' },
        },
        privacy: { transport: okAttempt?.provider === 'anyone' ? 'anyone-socks' : 'direct', mechanism: null },
        routing: {
          comparison: b.comparison ?? 'not-run',
          providersTried: b.attempts.length,
          providerLabel: okAttempt?.provider ?? null,
          // Same shape the engine writes (receipt.rs RoutingAttempt).
          attempts: b.attempts.map((a) => ({
            provider: a.provider,
            outcome: a.outcome === 'ok' ? 'success' : a.outcome === 'INVALID_PROOF' ? 'invalid-proof' : a.outcome === 'transport_error' ? 'transport-failure' : 'provider-error',
            elapsedMs: a.elapsedMs,
            ...(a.reason && a.outcome !== 'ok' ? { failureReason: `${a.outcome}: ${a.reason}` } : {}),
          })),
        },
        freshness: { observedAt: Math.floor(b.at / 1000), ageSeconds: 768 + Math.floor((b.at / 1000) % 12), pinned: true },
        warnings: b.warnings ?? [],
      }
  return ReceiptRecordSchema.parse({
    id,
    createdAt: b.at,
    method: b.method,
    params: { address: b.address, ...(b.slot ? { slot: b.slot } : {}) },
    value: b.value !== undefined && !b.error ? `0x${b.value.toString(16)}` : null,
    blockNumber: n,
    receipt,
    error: b.error ?? null,
    attempts: b.attempts,
  })
}

const ok = (provider: string, ms: number): Attempt => ({ provider, outcome: 'ok', elapsedMs: ms })

function attemptsForMode(mode: AttackMode, r: () => number, n: number): Attempt[] {
  const honest = ok(r() > 0.3 ? 'honest' : 'publicnode', 140 + Math.round(r() * 140))
  switch (mode) {
    case 'off':
      return [honest]
    case 'value':
      // Same as the engine: a claimed balance that differs from the proven one is INVALID_PROOF.
      return [
        { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 190 + Math.round(r() * 60), reason: 'claimed account does not match the proven account' },
        honest,
      ]
    case 'proof':
      return [
        { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 200 + Math.round(r() * 40), reason: 'account proof does not chain to pinned stateRoot' },
        honest,
      ]
    case 'wrongblock':
      return [
        { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 210 + Math.round(r() * 40), reason: `wrong block: proof is for #${n - 100}, pinned #${n}` },
        honest,
      ]
    case 'outage':
      return [{ provider: 'attacker', outcome: 'transport_error', elapsedMs: 30 + Math.round(r() * 20), reason: 'HTTP 503 Service Unavailable' }, honest]
    case 'nonce':
      // The forged nonce is in the claimed account, so every account read from the attacker fails.
      return [
        { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 190 + Math.round(r() * 60), reason: 'claimed account does not match the proven account' },
        honest,
      ]
    case 'code':
      // Only eth_getCode is altered; a balance read from the attacker is honest and verifies.
      return [ok('attacker', 150 + Math.round(r() * 80))]
  }
}

// ---------- feed state ----------
const records: ReceiptRecord[] = [] // newest first
let lastInvalidProofAt = 0
let nextAt = T0 + 2500
let counter = 0
let attackerMode: AttackMode = 'off'

function randomRead(at: number, mode: AttackMode): ReceiptRecord {
  const r = rng(`read-${at}-${counter++}`)
  const storage = r() < 0.25
  const address = storage ? DEMO_STORAGE : SAMPLE_ADDRESSES[Math.floor(r() * SAMPLE_ADDRESSES.length)]
  const viaAttacker = mode !== 'off' && r() < 0.4
  const attempts = attemptsForMode(viaAttacker ? mode : 'off', r, blockAt(at))
  if (attempts.some((a) => a.outcome === 'INVALID_PROOF')) lastInvalidProofAt = at
  return build({
    at,
    method: storage ? 'veriq_readStorage' : 'veriq_readBalance',
    address,
    slot: storage ? '0x0' : undefined,
    value: storage ? 42n : balanceFor(address),
    attempts,
  })
}

function seed() {
  const MIN = 60_000
  const specials = new Map<number, ReceiptRecord>()
  const failoverA = T0 - 41 * MIN
  specials.set(failoverA, build({
    at: failoverA,
    method: 'veriq_readBalance',
    address: SAMPLE_ADDRESSES[1],
    value: balanceFor(SAMPLE_ADDRESSES[1]),
    attempts: [
      { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 212, reason: `wrong block: proof is for #${blockAt(failoverA) - 100}, pinned #${blockAt(failoverA)}` },
      ok('honest', 184),
    ],
  }))
  const policyErr = T0 - 27 * MIN
  specials.set(policyErr, build({
    at: policyErr,
    method: 'veriq_readBalance',
    address: DEMO_ADDRESS,
    attempts: [],
    error: { code: ERROR_CODES.POLICY_UNSATISFIABLE, message: 'blockPolicy=latest cannot satisfy verification=required' },
  }))
  const failoverB = T0 - 90_000
  specials.set(failoverB, build({
    at: failoverB,
    method: 'veriq_readBalance',
    address: DEMO_ADDRESS,
    value: balanceFor(DEMO_ADDRESS),
    attempts: [
      { provider: 'attacker', outcome: 'INVALID_PROOF', elapsedMs: 207, reason: 'account proof does not chain to pinned stateRoot' },
      ok('honest', 171),
    ],
  }))
  lastInvalidProofAt = failoverB

  const out: ReceiptRecord[] = [...specials.values()]
  for (let t = T0 - 60 * MIN + 20_000; t < T0; t += 70_000 + Math.floor(rng(`gap-${t}`)() * 30_000)) {
    out.push(randomRead(t, 'off'))
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  records.push(...out)
}
seed()

function tick(now: number) {
  while (nextAt <= now) {
    records.unshift(randomRead(nextAt, attackerMode))
    nextAt += 3000 + Math.floor(rng(`next-${nextAt}`)() * 3500)
  }
  if (records.length > 500) records.length = 500
}

export function mockReceipts(limit: number): ReceiptRecord[] {
  tick(Date.now())
  return records.slice(0, limit)
}

// ---------- health ----------
export function mockHealth(): EngineHealth {
  const now = Date.now()
  const n = blockAt(now)
  const cooldownUntil = lastInvalidProofAt + 5 * 60_000
  const attackerOpen = cooldownUntil > now
  const providers: ProviderHealth[] = [
    { name: 'honest', chainOk: true, proofSupport: true, eip1898: true, transport: 'direct', breaker: { state: 'closed' }, successRate: 1, lastError: null },
    { name: 'publicnode', chainOk: true, proofSupport: true, eip1898: false, transport: 'direct', breaker: { state: 'closed' }, successRate: 0.99, lastError: 'timeout after 2.1 s (3h ago)' },
    {
      name: 'attacker',
      chainOk: true,
      proofSupport: true,
      eip1898: true,
      transport: 'direct',
      breaker: attackerOpen
        ? { state: 'open', cooldownUntil, reason: 'INVALID_PROOF' }
        : { state: 'closed' },
      successRate: 0.62,
      lastError: 'INVALID_PROOF: account proof does not chain to pinned stateRoot',
    },
    { name: 'anyone', chainOk: true, proofSupport: true, eip1898: false, transport: 'anyone-socks', breaker: { state: 'closed' }, successRate: 0.97, lastError: null },
  ]
  return EngineHealthSchema.parse({
    ok: true,
    chainId: 11155111,
    bind: '127.0.0.1:8547',
    rootSource: 'local-light-client',
    devMode: false,
    providers,
    lightClient: {
      synced: true,
      finalizedNumber: n,
      finalizedHash: blockHash(n),
      headNumber: n + 64,
      lagSeconds: Math.floor(((now - T0) % BLOCK_MS) / 1000),
      lastUpdateUnix: Math.floor((T0 + (n - BLOCK_AT_T0) * BLOCK_MS) / 1000),
      checkpoint: hex0x('checkpoint'),
      checkpointSource: 'backend/config/checkpoint.toml (pinned)',
    },
  })
}

// ---------- attacker + reads ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function mockGetMode(): AttackMode {
  return attackerMode
}
export function mockSetMode(mode: AttackMode) {
  attackerMode = mode
}

export class PlainRpcError extends Error {}

export async function mockPlainBalance(address: string): Promise<bigint> {
  await sleep(220 + Math.random() * 150)
  const honest = balanceFor(address)
  switch (attackerMode) {
    case 'off':
      return honest
    case 'value':
    case 'proof':
      return honest + FORGED_BONUS
    case 'wrongblock':
      return honest - honest / 8n
    case 'outage':
      throw new PlainRpcError('HTTP 503 Service Unavailable')
    case 'nonce':
    case 'code':
      // These modes forge the nonce or the code, not eth_getBalance.
      return honest
  }
}

export async function mockReadBalance(address: string, policy: Policy): Promise<VerifiedResult<bigint>> {
  await sleep(300 + Math.random() * 250)
  const at = Date.now()
  const fail = (code: number, message: string): never => {
    records.unshift(build({ at, method: 'veriq_readBalance', address, attempts: [], error: { code, message } }))
    throw new VeriqError(code, message)
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail(ERROR_CODES.INVALID_REQUEST, 'address must be 20-byte hex')
  if (policy.blockPolicy === 'latest' && policy.verification === 'required')
    fail(ERROR_CODES.POLICY_UNSATISFIABLE, 'blockPolicy=latest cannot satisfy verification=required')
  if (policy.privacy === 'required')
    fail(ERROR_CODES.PRIVACY_UNAVAILABLE, 'no healthy private-transport provider (privacy is after-MVP)')

  const r = rng(`manual-${at}`)
  const attempts = attemptsForMode(attackerMode, r, blockAt(at))
  if (policy.consistency === 'compare') attempts.push(ok('publicnode', 160 + Math.round(r() * 80)))
  if (attempts.some((a) => a.outcome === 'INVALID_PROOF')) lastInvalidProofAt = at

  const unverified = policy.verification === 'disabled' || policy.blockPolicy === 'latest'
  const warnings: TrustReceipt['warnings'] = []
  if (policy.blockPolicy === 'latest') warnings.push({ code: 'latest-not-verifiable', message: 'latest block root cannot be authenticated' })
  if (policy.verification === 'disabled') warnings.push({ code: 'verification-disabled', message: 'value returned without proof checks' })
  if (policy.privacy === 'preferred') warnings.push({ code: 'privacy-downgraded', message: 'private transport unavailable; sent direct' })

  const record = build({
    at,
    method: 'veriq_readBalance',
    address,
    value: balanceFor(address),
    attempts,
    status: unverified ? 'unverified' : 'verified',
    finalized: policy.blockPolicy === 'finalized',
    comparison: policy.consistency === 'compare' ? 'agree' : 'not-run',
    warnings,
  })
  records.unshift(record)
  if (!record.receipt) throw new Error('mock receipt missing')
  return { value: balanceFor(address), receipt: record.receipt, verified: record.receipt.verification.status === 'verified', attempts }
}
