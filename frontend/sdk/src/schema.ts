import { z } from 'zod'

/*
 * Mirrors backend/crates/core/src/receipt.rs and backend/crates/core/src/policy.rs field for field.
 * Change both in the same PR. B256 serializes as 0x-hex, u64/u32 as JSON numbers,
 * Option<T> as null, enums as kebab-case strings.
 */

const HEX = 'expected 0x-hex'
const hex = (bytes?: number) =>
  z
    .string({ required_error: HEX, invalid_type_error: HEX })
    .regex(bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]+$/, bytes ? `expected 0x-hex (${bytes} bytes)` : HEX)

const u64 = z.number({ required_error: 'expected a number' }).int().nonnegative()

/** 32-byte hash (B256). */
export const Hex32Schema = hex(32)

// ---------------------------------------------------------------- enums

export const VerificationStatusSchema = z.enum(['verified', 'unverified', 'unsupported'])
export const RootSourceSchema = z.enum(['local-light-client', 'fixture', 'untrusted-rpc'])
export const VerifierLocationSchema = z.enum(['local-engine', 'remote-engine', 'browser'])
export const MechanismSchema = z.enum(['account-proof', 'storage-proof', 'code-hash'])
export const TransportKindSchema = z.enum(['direct', 'ohttp', 'anyone-socks', 'anon-rpc'])
export const ComparisonSchema = z.enum(['not-run', 'agree', 'divergent'])

// ---------------------------------------------------------------- receipt.rs

export const IdentitySchema = z.object({
  requestId: z.string(),
  method: z.string(),
  requestBinding: z.string(),
  resultBinding: z.string(),
})

export const BlockSchema = z.object({
  number: u64,
  hash: Hex32Schema,
  stateRoot: Hex32Schema,
  finalized: z.boolean(),
})

export const BootstrapSchema = z.object({
  source: z.string().nullable().default(null),
  checkpoint: z.string().nullable().default(null),
  checkpointSource: z.string().nullable().default(null),
})

export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  rootSource: RootSourceSchema,
  verifierLocation: VerifierLocationSchema,
  mechanisms: z.array(MechanismSchema),
  bootstrap: BootstrapSchema,
})

export const PrivacySchema = z.object({
  transport: TransportKindSchema,
  mechanism: z.string().nullable().default(null),
})

/** `AttemptOutcome` in receipt.rs. */
export const AttemptOutcomeSchema = z.enum(['success', 'transport-failure', 'provider-error', 'invalid-proof'])

/** `RoutingAttempt` in receipt.rs: one provider tried for this read. */
export const RoutingAttemptSchema = z.object({
  provider: z.string(),
  outcome: AttemptOutcomeSchema,
  elapsedMs: u64,
  failureReason: z.string().nullish(),
})

export const RoutingSchema = z.object({
  comparison: ComparisonSchema,
  providersTried: u64,
  providerLabel: z.string().nullable().default(null),
  // #[serde(default)] in receipt.rs: older receipts without attempts still parse.
  attempts: z.array(RoutingAttemptSchema).default([]),
})

export const FreshnessSchema = z.object({
  observedAt: u64,
  ageSeconds: u64,
  pinned: z.boolean(),
})

export const WarningSchema = z.object({ code: z.string(), message: z.string() })

/** The Trust Receipt attached to every engine answer (`Receipt` in receipt.rs). */
export const TrustReceiptSchema = z.object({
  identity: IdentitySchema,
  block: BlockSchema,
  verification: VerificationSchema,
  privacy: PrivacySchema,
  routing: RoutingSchema,
  freshness: FreshnessSchema,
  warnings: z.array(WarningSchema).default([]),
})

// ---------------------------------------------------------------- policy.rs (+ README "Policies")

/** `VerificationPolicy` in policy.rs. */
export const VerificationPolicySchema = z.enum(['required', 'preferred', 'disabled'])
/** `BlockPolicy` in policy.rs. */
export const BlockPolicySchema = z.enum(['finalized', 'latest'])

/**
 * Full request policy. Only `verification` and `blockPolicy` exist in policy.rs today;
 * `privacy`, `consistency` and `timeoutMs` follow the README.
 */
export const PolicySchema = z.object({
  verification: VerificationPolicySchema,
  privacy: z.enum(['required', 'preferred', 'off']),
  consistency: z.enum(['single', 'compare']),
  blockPolicy: BlockPolicySchema,
  timeoutMs: z.number().int().min(1).max(120_000),
})

// ---------------------------------------------------------------- engine envelopes
// Not part of the locked receipt: what the engine wraps around it.

/** One provider attempt. `outcome` is "ok", an error name such as INVALID_PROOF, or "transport_error". */
/** receipt.rs `AttemptOutcome` -> the display label used across the SDK and dashboard. */
export const OUTCOME_LABEL: Record<string, string> = {
  success: 'ok',
  'invalid-proof': 'INVALID_PROOF',
  'transport-failure': 'transport_error',
  'provider-error': 'PROVIDER_ERROR',
}

/**
 * Accepts both attempt forms the engine writes: receipt.rs `RoutingAttempt`
 * ({ outcome: "invalid-proof", failureReason }) and the display form ({ outcome: "INVALID_PROOF", reason }).
 */
function normalizeAttempt(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const a = raw as Record<string, unknown>
  const outcome = typeof a.outcome === 'string' ? (OUTCOME_LABEL[a.outcome] ?? a.outcome) : a.outcome
  const reason = a.reason ?? a.failureReason
  return { provider: a.provider, outcome, elapsedMs: a.elapsedMs, ...(reason != null ? { reason } : {}) }
}

export const AttemptSchema = z.preprocess(
  normalizeAttempt,
  z.object({
    provider: z.string(),
    outcome: z.string(),
    elapsedMs: z.number().nonnegative(),
    reason: z.string().nullish(),
  }),
)

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
})

/** Result of veriq_readBalance / veriq_readStorage. `value` is a hex quantity. */
export const ReadResultSchema = z.object({
  value: hex(),
  receipt: TrustReceiptSchema,
  attempts: z.array(AttemptSchema).default([]),
})

/** `veriq_getRoot`: the finalized block the engine verifies against right now. */
export const RootInfoSchema = z.object({
  number: z.number().int().nonnegative(),
  hash: hex(),
  stateRoot: hex(),
  rootSource: z.string(),
  verified: z.boolean(),
})

/** A stored receipt row (GET /receipts, GET /receipts/:id). Failed reads carry `error` instead of `receipt`. */
export const ReceiptRecordSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  method: z.string(),
  params: z.object({ address: z.string().optional(), slot: z.string().optional() }),
  value: z.string().nullish(),
  blockNumber: u64.nullish(),
  receipt: TrustReceiptSchema.nullish(),
  error: RpcErrorSchema.nullish(),
  attempts: z.array(AttemptSchema).default([]),
})

export const ReceiptListSchema = z.object({ receipts: z.array(ReceiptRecordSchema) })

export const BreakerStateSchema = z.enum(['closed', 'open', 'half-open'])

export const ProviderHealthSchema = z.object({
  name: z.string(),
  chainOk: z.boolean(),
  proofSupport: z.boolean(),
  eip1898: z.boolean(),
  transport: TransportKindSchema.default('direct'),
  breaker: z.object({
    state: BreakerStateSchema,
    cooldownUntil: z.number().nullish(),
    reason: z.string().nullish(),
  }),
  successRate: z.number().min(0).max(1).nullish(),
  lastError: z.string().nullish(),
})

/** `LightClientStatus` in backend/crates/light-client, plus optional head/checkpoint info. */
export const LightClientStatusSchema = z.object({
  synced: z.boolean(),
  finalizedNumber: u64.nullish(),
  finalizedHash: Hex32Schema.nullish(),
  lagSeconds: u64.nullish(),
  lastUpdateUnix: u64.nullish(),
  headNumber: u64.nullish(),
  checkpoint: z.string().nullish(),
  checkpointSource: z.string().nullish(),
})

const EngineHealthShape = z.object({
  ok: z.boolean().default(true),
  chainId: z.number().int().optional(),
  bind: z.string().optional(),
  /** null while the engine has no root (light client not synced). */
  rootSource: RootSourceSchema.nullable(),
  devMode: z.boolean().default(false),
  /** Per-provider health. Empty when the engine only reports a count. */
  providers: z.array(ProviderHealthSchema),
  providerCount: z.number().int().nonnegative(),
  lightClient: LightClientStatusSchema,
  /** Why the engine is degraded, e.g. ROOT_UNAVAILABLE. */
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
})

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The engine's GET /health (backend/crates/server/src/http.rs) is flat:
 *   { status: "ok"|"degraded", synced, rootSource?, finalizedNumber?, finalizedHash?, headNumber?, lagSeconds?,
 *     providers: <count>, bootstrap?, bind, error?, message? }
 * This turns it into EngineHealth. The nested shape is accepted unchanged.
 */
function normalizeHealth(raw: unknown): unknown {
  if (!isObj(raw)) return raw
  const providers = Array.isArray(raw.providers) ? raw.providers : []
  const providerCount = typeof raw.providers === 'number' ? raw.providers : providers.length
  if (isObj(raw.lightClient)) return { rootSource: null, providerCount, ...raw, providers }
  const bootstrap = isObj(raw.bootstrap) ? raw.bootstrap : {}
  const rootSource = typeof raw.rootSource === 'string' ? raw.rootSource : null
  return {
    ok: raw.status === undefined ? true : raw.status === 'ok',
    ...(typeof raw.bind === 'string' ? { bind: raw.bind } : {}),
    rootSource,
    devMode: rootSource === 'untrusted-rpc',
    providers,
    providerCount,
    lightClient: {
      synced: raw.synced === true,
      finalizedNumber: raw.finalizedNumber ?? null,
      finalizedHash: raw.finalizedHash ?? null,
      lagSeconds: raw.lagSeconds ?? null,
      lastUpdateUnix: raw.lastUpdateUnix ?? null,
      headNumber: raw.headNumber ?? null,
      checkpoint: bootstrap.checkpoint ?? null,
      checkpointSource: bootstrap.checkpointSource ?? null,
    },
    error: typeof raw.error === 'string' ? { code: raw.error, message: typeof raw.message === 'string' ? raw.message : '' } : null,
  }
}

/** GET /health (normalized; see normalizeHealth). */
export const EngineHealthSchema = z.preprocess(normalizeHealth, EngineHealthShape)

/** veriq_getCapabilities */
export const CapabilitiesSchema = z
  .object({
    methods: z.array(z.string()),
    verifiedMethods: z.array(z.string()).default([]),
    blockPolicies: z.array(BlockPolicySchema).default(['finalized']),
    privacy: z.boolean().default(false),
  })
  .passthrough()

// ---------------------------------------------------------------- readable issues

function valueAt(input: unknown, path: (string | number)[]): unknown {
  let cur: unknown = input
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

function show(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return JSON.stringify(v.length > 24 ? `${v.slice(0, 24)}…` : v)
  if (v === null || typeof v !== 'object') return String(v)
  return Array.isArray(v) ? 'array' : 'object'
}

/** "receipt.block.stateRoot: expected 0x-hex, got undefined" */
export function formatIssues(error: z.ZodError, input: unknown, root: string): string[] {
  return error.issues.map((issue) => {
    const path = [root, ...issue.path].join('.')
    const got = show(valueAt(input, issue.path))
    let what = issue.message
    if (issue.code === 'invalid_type' && issue.message === 'Required') what = `expected ${issue.expected}`
    else if (issue.code === 'invalid_type' && issue.message.startsWith('Expected')) what = `expected ${issue.expected}`
    else if (issue.code === 'invalid_enum_value') what = `expected one of ${issue.options.join(' | ')}`
    return `${path}: ${what}, got ${got}`
  })
}
