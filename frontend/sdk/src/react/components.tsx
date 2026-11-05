import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import {
  formatEth,
  formatNumber,
  rootSourceLabel,
  shortHash,
  type Attempt,
  type EngineHealth,
  type Policy,
  type TrustReceipt,
  type VerificationStatus,
  type VeriqError,
} from 'veriq-client'
import { useVeriqClient } from './provider'
import { useVerifiedBalance, useVerifiedStorage, useVeriqHealth } from './hooks'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type DivProps = Omit<HTMLAttributes<HTMLElement>, 'children'>

// ---------------------------------------------------------------- ReceiptBadge

export type BadgeSize = 'sm' | 'md' | 'lg'

export interface ReceiptBadgeProps extends DivProps {
  status?: VerificationStatus
  /** Shows the error's code name in the error colour. Takes precedence over `status`. */
  error?: VeriqError | null
  /** Override the label text. */
  label?: ReactNode
  size?: BadgeSize
}

const STATUS_LABEL: Record<VerificationStatus, string> = { verified: 'Verified', unverified: 'Unverified', unsupported: 'Unsupported' }

/**
 * Status pill with a small dot: verified (green), unverified (amber), unsupported (lavender), error (rose).
 * @example <ReceiptBadge status={receipt.verification.status} />
 * @example <ReceiptBadge error={err} />
 */
export function ReceiptBadge({ status = 'unsupported', error, label, size = 'sm', className, ...rest }: ReceiptBadgeProps) {
  const kind = error ? 'error' : status
  return (
    <span {...rest} className={cx('vq-badge', `vq-badge--${kind}`, `vq-badge--${size}`, className)}>
      <span className="vq-badge__dot" aria-hidden="true" />
      {label ?? (error ? error.codeName : STATUS_LABEL[status])}
    </span>
  )
}

// ---------------------------------------------------------------- Hash (copy on click)

/**
 * Monospace, middle-truncated hash that copies on click and shows a "Copied" tick.
 * @example <CopyHash value={receipt.block.stateRoot} />
 */
export function CopyHash({ value, head = 6, tail = 6, className }: { value: string; head?: number; tail?: number; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className={cx('vq-hash', copied && 'vq-hash--copied', className)}
      title={value}
      aria-label={`Copy ${value}`}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(value).then(() => setCopied(true))
      }}
    >
      <span>{shortHash(value, head, tail)}</span>
      <span className="vq-hash__tick" aria-live="polite">{copied ? '✓ Copied' : ''}</span>
    </button>
  )
}

// ---------------------------------------------------------------- ReceiptCard

export interface ReceiptCardProps extends DivProps {
  receipt?: TrustReceipt | null
  /** Proven value: wei for balances, hex or bigint for storage. */
  value?: bigint | string | null
  attempts?: Attempt[]
  /** Show a failed read instead of a receipt. */
  error?: VeriqError | null
  /** Custom value formatter. Default: ETH for balances, raw for storage. */
  formatValue?: (value: bigint | string, receipt: TrustReceipt | null) => ReactNode
  /** Extra line under the value (method, address, time…). */
  subtitle?: ReactNode
  /** Extra elements next to the status badge. */
  badgeExtra?: ReactNode
  /** What "Raw JSON" and the download contain. Default: the receipt. */
  raw?: unknown
}

function defaultValue(value: bigint | string, receipt: TrustReceipt | null): ReactNode {
  if (receipt && /storage/i.test(receipt.identity.method)) {
    const v = typeof value === 'bigint' ? value : BigInt(value)
    return v.toString()
  }
  return formatEth(value)
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="vq-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function download(json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'receipt.json'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * A full Trust Receipt in the dashboard's card style.
 * @example <ReceiptCard receipt={result.receipt} value={result.value} attempts={result.attempts} />
 */
export function ReceiptCard({ receipt, value, attempts = [], error, formatValue = defaultValue, subtitle, badgeExtra, raw, className, ...rest }: ReceiptCardProps) {
  const r = receipt ?? null
  const json = JSON.stringify(raw ?? r ?? (error ? { code: error.code, name: error.codeName, message: error.message } : null), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)
  return (
    <section {...rest} className={cx('vq-card', className)}>
      <div className="vq-card__head">
        <div className="vq-card__badges">
          <ReceiptBadge size="lg" {...(error ? { error } : { status: r?.verification.status ?? 'unsupported' })} />
          {badgeExtra}
        </div>
        {error ? (
          <div className="vq-card__error">
            <div className="vq-mono vq-text-err">
              {error.codeName} · {error.code}
            </div>
            <p className="vq-card__meaning">{error.meaning}</p>
            <p className="vq-muted">{error.message}</p>
            <p className="vq-hint">→ {error.hint}</p>
          </div>
        ) : (
          value != null && <div className="vq-card__value">{formatValue(value, r)}</div>
        )}
        {subtitle && <div className="vq-card__subtitle">{subtitle}</div>}
      </div>

      {r && (
        <dl className="vq-card__section">
          <Row label="Block">
            <span className="vq-mono">
              #{formatNumber(r.block.number)} {r.block.finalized ? <span className="vq-text-ok">finalized</span> : <span className="vq-text-warn">not finalized</span>}
            </span>
            <CopyHash value={r.block.hash} />
          </Row>
          <Row label="State root">
            <CopyHash value={r.block.stateRoot} />
          </Row>
          <Row label="Root source">
            <span className={cx('vq-chip', r.verification.rootSource === 'untrusted-rpc' ? 'vq-chip--warn' : 'vq-chip--ok')}>{rootSourceLabel(r.verification.rootSource)}</span>
          </Row>
          <Row label="Verifier">
            <span className="vq-mono">{r.verification.verifierLocation}</span>
          </Row>
          <Row label="Mechanisms">
            <span className="vq-chips">
              {r.verification.mechanisms.length === 0 ? <span className="vq-muted">none</span> : r.verification.mechanisms.map((m) => <span key={m} className="vq-chip vq-chip--lav">{m}</span>)}
            </span>
          </Row>
          <Row label="Transport">
            <span className="vq-mono">{r.privacy.transport}</span>
          </Row>
          <Row label="Comparison">
            <span className="vq-mono">{r.routing.comparison}</span>
          </Row>
          {r.warnings.length > 0 && (
            <Row label="Warnings">
              <ul className="vq-list">
                {r.warnings.map((w) => (
                  <li key={w.code} className="vq-text-warn">
                    <span className="vq-mono">{w.code}</span> — {w.message}
                  </li>
                ))}
              </ul>
            </Row>
          )}
        </dl>
      )}

      <div className="vq-card__section">
        <h4 className="vq-card__h">Attempts</h4>
        {attempts.length === 0 ? (
          <p className="vq-muted">{r ? `${r.routing.providersTried} provider(s) tried${r.routing.providerLabel ? `, answered by ${r.routing.providerLabel}` : ''}.` : 'No provider was contacted.'}</p>
        ) : (
          <ol className="vq-attempts">
            {attempts.map((a, i) => (
              <li key={i} className={cx('vq-attempt', a.outcome === 'ok' ? 'vq-attempt--ok' : 'vq-attempt--rejected')}>
                <span className="vq-attempt__dot" aria-hidden="true" />
                <div className="vq-attempt__body">
                  <div className="vq-attempt__line">
                    <span className="vq-attempt__provider">{a.provider}</span>
                    <span className="vq-mono vq-attempt__outcome">{a.outcome}</span>
                    <span className="vq-mono vq-attempt__ms">{Math.round(a.elapsedMs)} ms</span>
                  </div>
                  {a.reason && <p className="vq-attempt__reason">{a.reason}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {r && (
        <div className="vq-card__section">
          <h4 className="vq-card__h">Bindings</h4>
          <dl>
          <Row label="requestBinding">
            <CopyHash value={r.identity.requestBinding} />
          </Row>
          <Row label="resultBinding">
            <CopyHash value={r.identity.resultBinding} />
          </Row>
          <Row label="requestId">
            <CopyHash value={r.identity.requestId} head={8} />
          </Row>
          </dl>
        </div>
      )}

      <details className="vq-raw">
        <summary>Raw JSON</summary>
        <pre>{json}</pre>
      </details>
      <button type="button" className="vq-pill" onClick={() => download(json)}>
        <span>Download receipt.json</span>
        <span className="vq-pill__circle" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v12M6 10l6 6 6-6M5 20h14" />
          </svg>
        </span>
      </button>
    </section>
  )
}

// ---------------------------------------------------------------- VerifiedValue

export interface VerifiedValueProps extends DivProps {
  address: string
  /** Read a storage slot instead of the balance. */
  slot?: string
  /** "eth" (default) for balances, "raw" for the number, or your own formatter. */
  format?: 'eth' | 'raw' | ((value: bigint | string) => ReactNode)
  policy?: Policy
  refreshInterval?: number
}

/**
 * A proven value in the heading style with its status badge. Click it for the full receipt.
 * @example <VerifiedValue address="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" />
 */
export function VerifiedValue({ address, slot, format = 'eth', policy, refreshInterval, className, ...rest }: VerifiedValueProps) {
  const opts = { ...(policy ? { policy } : {}), ...(refreshInterval ? { refreshInterval } : {}) }
  const balance = useVerifiedBalance(slot ? null : address, opts)
  const storage = useVerifiedStorage(slot ? address : null, slot ?? null, opts)
  const q = slot ? storage : balance
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onDown = (e: MouseEvent) => wrapRef.current && !wrapRef.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  if (q.isLoading && !q.data) {
    return <span {...rest} className={cx('vq-value', className)} aria-busy="true"><span className="vq-skeleton vq-skeleton--value" /><span className="vq-skeleton vq-skeleton--badge" /></span>
  }
  if (q.error && !q.data) {
    return (
      <span {...rest} role="alert" className={cx('vq-value vq-value--error', className)}>
        <ReceiptBadge error={q.error} />
        <span className="vq-value__hint">
          <strong>{q.error.name}</strong> {q.error.hint}
        </span>
      </span>
    )
  }
  if (!q.data) return null
  const v = q.data.value
  const shown = typeof format === 'function' ? format(v) : format === 'raw' || slot ? BigInt(v).toString() : formatEth(v)
  return (
    <span {...rest} ref={wrapRef} className={cx('vq-value vq-fade', className)}>
      <button type="button" className="vq-value__button" aria-expanded={open} aria-controls={popId} onClick={() => setOpen((o) => !o)}>
        <span className="vq-value__num">{shown}</span>
        <ReceiptBadge status={q.data.receipt.verification.status} />
      </button>
      {open && (
        <span id={popId} role="dialog" aria-label="Trust receipt" className="vq-popover vq-fade">
          <ReceiptCard receipt={q.data.receipt} value={v} attempts={q.data.attempts} />
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------- EngineStatus

export interface EngineStatusProps extends DivProps {
  /** Controlled mode: pass health yourself (null = offline). Omit to fetch with useVeriqHealth. */
  health?: EngineHealth | null
  /** Shown when online and the engine doesn't report `bind`. Default 127.0.0.1:8547. */
  address?: string
  refreshInterval?: number
}

/**
 * "● Engine online · 127.0.0.1:8547" / grey "● Engine offline", plus an amber DEV MODE pill for untrusted roots.
 * @example <EngineStatus />
 */
export function EngineStatus({ health, address, refreshInterval, className, ...rest }: EngineStatusProps) {
  const controlled = health !== undefined
  const hasClient = useVeriqClient() !== null
  const q = useVeriqHealth({ enabled: !controlled && hasClient, ...(refreshInterval ? { refreshInterval } : {}) })
  const h = controlled ? health : (q.data ?? null)
  const online = h !== null && h !== undefined && (controlled || !q.error)
  const dev = online && (h.devMode || h.rootSource === 'untrusted-rpc')
  return (
    <span {...rest} className={cx('vq-status-group', className)}>
      <span className={cx('vq-status', online ? 'vq-status--online' : 'vq-status--offline')} role="status">
        <span className="vq-status__dot" aria-hidden="true" />
        <span className="vq-status__label">{online ? `Engine online · ${address ?? h.bind ?? '127.0.0.1:8547'}` : !controlled && q.isLoading ? 'Checking engine…' : 'Engine offline'}</span>
      </span>
      {dev && <span className="vq-status vq-status--dev">DEV MODE — unverified</span>}
    </span>
  )
}
