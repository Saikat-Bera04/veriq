import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import type { ReceiptRecord } from 'veriq-client'
import { useReceipts } from '../lib/engine'
import { formatTime, methodLabel } from '../lib/format'
import { RecordBadge, formatValue, recordProvider, recordStatus } from '../components/ReceiptDrawer'
import { Card, EmptyState, ErrorCard, Hash, SampleTag, SecondaryButton, Skeleton, Stagger, cx } from '../components/ui'

const STATUSES: ('all' | ReturnType<typeof recordStatus>)[] = ['all', 'verified', 'unverified', 'unsupported', 'error']
const FLASH = { opacity: 0, y: -12, backgroundColor: 'rgba(236, 234, 248, 1)' }
const SETTLED = { opacity: 1, y: 0, backgroundColor: 'rgba(236, 234, 248, 0)' }

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-vq-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="vq-focus h-10 rounded-full border border-vq-border bg-vq-surface px-4 pr-8 text-sm font-medium"
      >
        {options.map((o) => <option key={o} value={o}>{o === 'all' ? `All` : o}</option>)}
      </select>
    </label>
  )
}

function Attempts({ r }: { r: ReceiptRecord }) {
  const rejected = r.attempts.filter((a) => a.outcome !== 'ok').length
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      {r.attempts.length}
      {rejected > 0 && <span className="text-vq-err text-xs">· {rejected} rejected</span>}
    </span>
  )
}

/** Tracks which ids have been on screen, so only truly new rows flash. */
function useNewIds(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const fresh = useMemo(() => {
    if (seen.current === null) return new Set<string>()
    const s = seen.current
    return new Set(ids.filter((id) => !s.has(id)))
  }, [ids])
  useEffect(() => {
    const s = seen.current ?? new Set<string>()
    ids.forEach((id) => s.add(id))
    seen.current = s
  }, [ids])
  return fresh
}

export function FeedPage() {
  const receipts = useReceipts()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<string>('all')
  const [method, setMethod] = useState('all')
  const [provider, setProvider] = useState('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)

  const all = useMemo(() => receipts.data?.data ?? [], [receipts.data])
  const methods = useMemo(() => ['all', ...new Set(all.map((r) => r.method))], [all])
  const providers = useMemo(() => ['all', ...new Set(all.flatMap((r) => r.attempts.map((a) => a.provider)))], [all])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter(
      (r) =>
        (status === 'all' || recordStatus(r) === status) &&
        (method === 'all' || r.method === method) &&
        (provider === 'all' || r.attempts.some((a) => a.provider === provider)) &&
        (!q || (r.params.address ?? '').toLowerCase().includes(q)),
    )
  }, [all, status, method, provider, query])

  const visible = rows.slice(0, limit)
  const ids = useMemo(() => visible.map((r) => r.id), [visible])
  const fresh = useNewIds(ids)
  const open = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('receipt', id)
    setParams(next)
  }
  const rowProps = (r: ReceiptRecord) => ({
    onClick: () => open(r.id),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open(r.id)
      }
    },
    tabIndex: 0,
    'aria-label': `Open receipt ${r.id}`,
    initial: fresh.has(r.id) ? FLASH : false,
    animate: SETTLED,
    transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
  })

  let body: ReactNode
  if (receipts.isLoading) {
    body = <div className="space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
  } else if (receipts.error) {
    body = <ErrorCard title="Couldn't load receipts" error={receipts.error} onRetry={() => void receipts.refetch()} />
  } else if (all.length === 0) {
    body = <EmptyState title="Waiting for the first read" body="Receipts appear here within two seconds of each veriq_* call." />
  } else if (rows.length === 0) {
    body = <EmptyState title="No receipts match" body="Try clearing a filter or the address search." />
  } else {
    body = (
      <>
        {/* table >= md */}
        <table className="hidden md:table w-full text-sm table-fixed">
          <thead>
            <tr className="text-left text-vq-muted text-xs">
              <th className="font-normal pb-3 w-[84px]">Time</th>
              <th className="font-normal pb-3 w-[110px]">Method</th>
              <th className="font-normal pb-3">Address</th>
              <th className="font-normal pb-3 text-right">Value</th>
              <th className="font-normal pb-3 pl-4 w-[124px]">Status</th>
              <th className="font-normal pb-3 w-[104px] hidden xl:table-cell">Block</th>
              <th className="font-normal pb-3 w-[100px] hidden xl:table-cell">Provider</th>
              <th className="font-normal pb-3 w-[120px] hidden lg:table-cell">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <motion.tr key={r.id} {...rowProps(r)} className="vq-focus cursor-pointer border-t border-vq-border hover:!bg-vq-bg">
                <td className="py-3 font-mono text-xs text-vq-muted">{formatTime(r.createdAt)}</td>
                <td className="py-3 font-mono text-xs truncate">{methodLabel(r.method)}</td>
                <td className="py-3 truncate">{r.params.address ? <Hash value={r.params.address} /> : '—'}</td>
                <td className="py-3 text-right tabular-nums font-medium truncate">{formatValue(r)}</td>
                <td className="py-3 pl-4"><RecordBadge record={r} /></td>
                <td className="py-3 font-mono text-xs hidden xl:table-cell">{r.blockNumber != null ? `#${r.blockNumber}` : '—'}</td>
                <td className="py-3 hidden xl:table-cell truncate">{recordProvider(r)}</td>
                <td className="py-3 hidden lg:table-cell"><Attempts r={r} /></td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {/* list < md */}
        <ul className="md:hidden -mx-2">
          {visible.map((r) => (
            <motion.li key={r.id} {...rowProps(r)} className="vq-focus cursor-pointer rounded-2xl px-2 py-3 border-b border-vq-border last:border-0">
              <div className="flex items-center justify-between gap-3">
                <RecordBadge record={r} />
                <span className="font-medium tabular-nums truncate">{formatValue(r)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-vq-muted">
                <span className="font-mono">{formatTime(r.createdAt)}</span>
                <span className="font-mono">{methodLabel(r.method)}</span>
                {r.params.address && <span className="font-mono">{r.params.address.slice(0, 6)}…{r.params.address.slice(-4)}</span>}
                <span>{recordProvider(r)}</span>
                <Attempts r={r} />
              </div>
            </motion.li>
          ))}
        </ul>
        {rows.length > limit && (
          <div className="mt-5 flex justify-center">
            <SecondaryButton onClick={() => setLimit((l) => l + 100)}>Show {Math.min(100, rows.length - limit)} more</SecondaryButton>
          </div>
        )}
      </>
    )
  }

  return (
    <Stagger className="space-y-4">
      <Card className="!p-5 md:!p-6">
        <div className="grid grid-cols-2 md:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
          <label className="col-span-2 md:col-span-1 flex flex-col gap-1">
            <span className="text-xs text-vq-muted">Search address</span>
            <span className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-vq-faint" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="0x…"
                className="vq-focus w-full h-10 rounded-full border border-vq-border bg-vq-surface pl-10 pr-4 text-sm font-mono"
              />
            </span>
          </label>
          <Select label="Status" value={status} onChange={setStatus} options={STATUSES} />
          <Select label="Method" value={method} onChange={setMethod} options={methods} />
          <div className="col-span-2 md:col-span-1">
            <Select label="Provider" value={provider} onChange={setProvider} options={providers} />
          </div>
        </div>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <span className="relative flex w-2.5 h-2.5" aria-hidden="true">
            <span className="absolute inset-0 rounded-full bg-vq-live motion-safe:animate-ping opacity-50" />
            <span className="relative w-2.5 h-2.5 rounded-full bg-vq-live" />
          </span>
          <span className="text-sm text-vq-muted">
            {rows.length} receipts · polling every 2 s
          </span>
          {receipts.data?.source === 'mock' && <SampleTag className="ml-auto" />}
        </div>
        <div className={cx(receipts.isFetching && 'transition-opacity')}>{body}</div>
      </Card>
    </Stagger>
  )
}
