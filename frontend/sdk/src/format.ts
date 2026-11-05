import type { Attempt, EngineHealth, Hex, RootSource, TrustReceipt, VerificationStatus } from './types'

const WEI = 10n ** 18n

/**
 * Wei -> "0.4213 ETH". Truncates (never rounds up a proven value); tiny non-zero amounts show as "<0.0001 ETH".
 * @example formatEth(421337000000000000n) // "0.4213 ETH"
 */
export function formatEth(wei: bigint | string | number, opts: { decimals?: number; symbol?: boolean } = {}): string {
  const decimals = opts.decimals ?? 4
  const unit = opts.symbol === false ? '' : ' ETH'
  const v = typeof wei === 'bigint' ? wei : BigInt(wei)
  const neg = v < 0n
  const abs = neg ? -v : v
  const whole = abs / WEI
  const frac = (abs % WEI).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '')
  if (whole === 0n && frac === '' && abs > 0n) return `${neg ? '>-' : '<'}0.${'0'.repeat(Math.max(0, decimals - 1))}1${unit}`
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}${unit}`
}

/**
 * Middle-truncate a hash or address: "0x1234…cdef".
 * @example shortHash('0x9a3f00000000000000000000000000000000000000000000000000000000c21e') // "0x9a3f…c21e"
 */
export function shortHash(hex: string, head = 4, tail = 4): string {
  const h = hex.startsWith('0x') ? head + 2 : head
  return hex.length <= h + tail + 1 ? hex : `${hex.slice(0, h)}…${hex.slice(-tail)}`
}

/** "7,412,903" */
export function formatNumber(n: number | bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Human label for a root source. */
export function rootSourceLabel(source: RootSource): string {
  switch (source) {
    case 'local-light-client':
      return 'local light client (Helios)'
    case 'fixture':
      return 'fixture (tests only)'
    case 'untrusted-rpc':
      return 'untrusted RPC (DEV MODE)'
  }
}

/** Anything prettyReceipt / formatReceipt can show: a bare receipt, or a read result with value + attempts. */
export type ReceiptInput = TrustReceipt | { receipt: TrustReceipt; value?: bigint | string; attempts?: Attempt[] }

export type RowTone = 'ok' | 'warn' | 'err' | 'lav' | 'muted' | 'ink'

/** One line of a receipt. `status` rows carry the status + formatted value. */
export interface ReceiptRow {
  label: string
  value: string
  tone?: RowTone
}

function split(input: ReceiptInput): { receipt: TrustReceipt; value?: bigint | string; attempts: Attempt[] } {
  if ('identity' in input) return { receipt: input, attempts: [] }
  return { receipt: input.receipt, ...(input.value !== undefined ? { value: input.value } : {}), attempts: input.attempts ?? [] }
}

export function statusTone(status: VerificationStatus): RowTone {
  return status === 'verified' ? 'ok' : status === 'unverified' ? 'warn' : 'lav'
}

function formatValue(receipt: TrustReceipt, value: bigint | string | undefined): string {
  if (value === undefined) return ''
  if (/storage/i.test(receipt.identity.method)) {
    const v = typeof value === 'bigint' ? value : BigInt(value)
    return v < 10n ** 15n ? v.toString() : shortHash(`0x${v.toString(16)}`)
  }
  return formatEth(value)
}

/** The rows shown by formatReceipt and prettyReceipt (shared so plain and colour output match). */
export function receiptRows(input: ReceiptInput): { status: VerificationStatus; value: string; rows: ReceiptRow[] } {
  const { receipt: r, value, attempts } = split(input)
  const rows: ReceiptRow[] = [
    { label: 'block', value: `#${formatNumber(r.block.number)}  ${shortHash(r.block.hash)}${r.block.finalized ? '' : '  (not finalized)'}` },
    { label: 'stateRoot', value: shortHash(r.block.stateRoot) },
    { label: 'root', value: rootSourceLabel(r.verification.rootSource), tone: r.verification.rootSource === 'untrusted-rpc' ? 'warn' : 'ink' },
  ]
  const total = attempts.reduce((s, a) => s + a.elapsedMs, 0)
  const tried = attempts.length || r.routing.providersTried
  const provider = [
    r.routing.providerLabel ?? '—',
    `${tried} attempt${tried === 1 ? '' : 's'}`,
    ...(attempts.length ? [`${Math.round(total)} ms`] : []),
  ].join('  ·  ')
  rows.push({ label: 'provider', value: provider })
  for (const a of attempts) {
    if (a.outcome !== 'ok') rows.push({ label: 'rejected', value: `${a.provider}  ${a.outcome}`, tone: 'err' })
  }
  if (r.routing.comparison !== 'not-run') rows.push({ label: 'compare', value: r.routing.comparison, tone: r.routing.comparison === 'agree' ? 'ok' : 'warn' })
  for (const w of r.warnings) rows.push({ label: 'warning', value: w.code, tone: 'warn' })
  return { status: r.verification.status, value: formatValue(r, value), rows }
}

/**
 * Plain multi-line text, no colours.
 * @example console.log(formatReceipt(await veriq.readBalance({ address })))
 */
export function formatReceipt(input: ReceiptInput): string {
  const { status, value, rows } = receiptRows(input)
  return [`${status.toUpperCase()}${value ? `  ${value}` : ''}`, ...rows.map((r) => `${r.label.padEnd(10)} ${r.value}`)].join('\n')
}

/** Rows for `veriq health`. */
export function healthRows(h: EngineHealth): { engine: ReceiptRow[]; providers: string[][] } {
  const lc = h.lightClient
  const lag = lc.finalizedNumber != null && lc.headNumber != null ? `${lc.headNumber - lc.finalizedNumber} blocks behind head` : ''
  const engine: ReceiptRow[] = [
    {
      label: 'engine',
      value: `${h.ok ? 'online' : `degraded${h.error ? ` · ${h.error.code}` : ''}`}${h.bind ? ` · ${h.bind}` : ''}`,
      tone: h.ok ? 'ok' : 'warn',
    },
    {
      label: 'root',
      value: h.rootSource ? rootSourceLabel(h.rootSource) : 'none yet (light client not synced)',
      tone: !h.rootSource || h.devMode || h.rootSource === 'untrusted-rpc' ? 'warn' : 'ink',
    },
    { label: 'light', value: lc.synced ? 'synced' : 'not synced', tone: lc.synced ? 'ok' : 'warn' },
    { label: 'finalized', value: lc.finalizedNumber != null ? `#${formatNumber(lc.finalizedNumber)}${lag ? `  ·  ${lag}` : ''}` : '—' },
  ]
  const providers = h.providers.map((p) => [
    p.name,
    p.chainOk ? 'yes' : 'no',
    p.proofSupport ? 'yes' : 'no',
    p.eip1898 ? 'yes' : 'no',
    p.breaker.state,
    p.transport,
  ])
  if (h.providers.length === 0) engine.push({ label: 'providers', value: `${h.providerCount} configured`, tone: 'ink' })
  return { engine, providers }
}

export type { Hex }
