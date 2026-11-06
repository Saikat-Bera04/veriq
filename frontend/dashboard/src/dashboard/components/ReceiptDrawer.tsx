import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { errorFromRpc, type Attempt, type ReceiptRecord } from 'veriq-client'
import { ReceiptBadge, ReceiptCard, type BadgeSize } from 'veriq-client/react'
import { getLocalReceipt, useEngineSource, useReceipts, veriq } from '../lib/engine'
import { formatEth, formatTime, methodLabel, toBigInt } from '../lib/format'
import { ErrorCard, Hash, SampleTag, Skeleton, cx } from './ui'

export function recordStatus(r: ReceiptRecord) {
  return r.error ? 'error' : (r.receipt?.verification.status ?? 'unsupported')
}

export function recordProvider(r: ReceiptRecord): string {
  return r.receipt?.routing.providerLabel ?? r.attempts[r.attempts.length - 1]?.provider ?? '—'
}

export function formatValue(r: ReceiptRecord): string {
  if (r.value == null) return '—'
  if (r.method.includes('Storage')) return toBigInt(r.value)?.toString() ?? r.value
  return `${formatEth(r.value)} ETH`
}

/** SDK badge for a stored receipt row (typed error for failed reads). */
export function RecordBadge({ record, size }: { record: ReceiptRecord; size?: BadgeSize }) {
  return record.error ? (
    <ReceiptBadge error={errorFromRpc(record.error)} {...(size ? { size } : {})} />
  ) : (
    <ReceiptBadge status={record.receipt?.verification.status ?? 'unsupported'} {...(size ? { size } : {})} />
  )
}

/** Attempts on the dark (aubergine) panels of the attack lab and policy pages. */
export function AttemptsTimeline({ attempts, dark = false }: { attempts: Attempt[]; dark?: boolean }) {
  if (attempts.length === 0) {
    return <p className={cx('text-sm', dark ? 'text-white/60' : 'text-vq-muted')}>No provider was contacted.</p>
  }
  return (
    <ol className="relative space-y-3">
      {attempts.map((a, i) => {
        const okay = a.outcome === 'ok'
        return (
          <li key={i} className="relative flex gap-3">
            <div className="flex flex-col items-center">
              <span className={cx('mt-1 w-3 h-3 rounded-full ring-4', okay ? 'bg-vq-ok ring-vq-ok-bg' : 'bg-vq-err ring-vq-err-bg')} aria-hidden="true" />
              {i < attempts.length - 1 && <span className="flex-1 w-px bg-vq-border mt-1" aria-hidden="true" />}
            </div>
            <div className={cx('flex-1 min-w-0 rounded-xl px-3.5 py-2.5 mb-0.5', okay ? (dark ? 'bg-white/5' : 'bg-vq-bg') : 'bg-vq-err-bg')}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={cx('font-medium text-sm', !okay ? 'text-vq-err' : dark ? 'text-white' : 'text-vq-ink')}>{a.provider}</span>
                <span className={cx('font-mono text-xs', okay ? 'text-vq-ok' : 'text-vq-err')}>{a.outcome}</span>
                <span className={cx('ml-auto font-mono text-xs tabular-nums', !okay ? 'text-vq-err/80' : dark ? 'text-white/50' : 'text-vq-muted')}>{a.elapsedMs} ms</span>
              </div>
              {a.reason && <p className={cx('text-xs mt-1', !okay ? 'text-vq-err/90' : dark ? 'text-white/60' : 'text-vq-muted')}>{a.reason}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** The drawer content is the SDK's ReceiptCard, so dashboard and SDK look identical. */
function DrawerBody({ record, mock }: { record: ReceiptRecord; mock: boolean }) {
  return (
    <ReceiptCard
      className="vq-card--flat"
      receipt={record.receipt ?? null}
      value={record.value ?? null}
      attempts={record.attempts}
      error={record.error ? errorFromRpc(record.error) : null}
      raw={record}
      formatValue={() => formatValue(record)}
      badgeExtra={mock ? <SampleTag /> : null}
      subtitle={
        <>
          <span className="font-mono">{methodLabel(record.method)}</span>
          {record.params.address && <Hash value={record.params.address} />}
          {record.params.slot && <span className="font-mono">slot {record.params.slot}</span>}
          <span>{formatTime(record.createdAt)}</span>
        </>
      }
    />
  )
}

export function ReceiptDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const source = useEngineSource()
  const list = useReceipts()
  // A receipt made in this browser (S5 local-only) is not in the engine's store.
  const cached = id ? (getLocalReceipt(id) ?? list.data?.data.find((r) => r.id === id)) : undefined
  const remote = useQuery({
    queryKey: ['receipt', id],
    queryFn: () => veriq.getReceiptRecord(id ?? ''),
    enabled: !!id && !cached && source === 'live',
  })
  const record = cached ?? remote.data
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!id) return
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>('button, a[href], summary, input, [tabindex]:not([tabindex="-1"])')
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [id])

  return (
    <AnimatePresence>
      {id && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40 bg-vq-aubergine/30 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            key="panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-title"
            className="fixed inset-y-0 right-0 z-50 w-full sm:w-[520px] bg-vq-surface shadow-pop flex flex-col sm:rounded-l-card"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          >
            <div className="flex items-center justify-between px-6 py-5 border-b border-vq-border">
              <h2 id="receipt-title" className="text-xl font-medium tracking-h3">Trust Receipt</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close receipt"
                className="vq-focus p-2 rounded-full hover:bg-vq-lav-100"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {record ? (
                <DrawerBody record={record} mock={source === 'mock'} />
              ) : remote.isLoading || list.isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="h-14 w-64" />
                  <Skeleton className="h-48 w-full" />
                </div>
              ) : remote.error ? (
                <ErrorCard title="Couldn't load this receipt" error={remote.error} onRetry={() => void remote.refetch()} />
              ) : (
                <p className="text-vq-muted">This receipt is no longer in the store.</p>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
