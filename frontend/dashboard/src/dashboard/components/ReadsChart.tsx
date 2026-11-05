import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts'
import type { ReceiptRecord } from 'veriq-client'
import { cx } from './ui'

const BUCKET_MS = 5 * 60_000
const VERIFIED = 'rgb(var(--vq-lavender-500))'
const REJECTED = 'rgb(var(--vq-err))'

interface Bucket {
  label: string
  verified: number
  rejected: number
}

function bucketize(records: ReceiptRecord[], now: number): Bucket[] {
  const end = Math.ceil(now / BUCKET_MS) * BUCKET_MS
  const start = end - 12 * BUCKET_MS
  const buckets: Bucket[] = Array.from({ length: 12 }, (_, i) => ({
    label: new Date(start + i * BUCKET_MS).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    verified: 0,
    rejected: 0,
  }))
  for (const r of records) {
    if (r.createdAt < start || r.createdAt >= end) continue
    const b = buckets[Math.floor((r.createdAt - start) / BUCKET_MS)]
    if (r.receipt?.verification.status === 'verified') b.verified++
    b.rejected += r.attempts.filter((a) => a.outcome !== 'ok').length + (r.error ? 1 : 0)
  }
  return buckets
}

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl bg-vq-surface border border-vq-border shadow-card px-3 py-2 text-xs">
      <div className="font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-vq-muted">
          <span className="w-2 h-2 rounded-sm" style={{ background: p.dataKey === 'verified' ? VERIFIED : REJECTED }} />
          <span className="text-vq-ink tabular-nums">{p.value}</span> {p.dataKey === 'verified' ? 'verified reads' : 'rejected'}
        </div>
      ))}
    </div>
  )
}

export function ReadsChart({ records, now }: { records: ReceiptRecord[]; now: number }) {
  // Re-bucket at most once a minute of wall time or when data changes.
  const minute = Math.floor(now / 60_000)
  const data = useMemo(() => bucketize(records, minute * 60_000 + 59_999), [records, minute])
  const [table, setTable] = useState(false)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-4 text-sm">
        <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-[4px]" style={{ background: VERIFIED }} />Verified reads</span>
        <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-[4px]" style={{ background: REJECTED }} />Rejected attempts</span>
        <button
          type="button"
          onClick={() => setTable((t) => !t)}
          className="vq-focus ml-auto text-xs font-medium text-vq-muted hover:text-vq-ink underline underline-offset-4 rounded"
          aria-pressed={table}
        >
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-vq-muted text-left">
              <tr><th className="font-normal py-1.5">5 min from</th><th className="font-normal text-right">Verified</th><th className="font-normal text-right">Rejected</th></tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label} className="border-t border-vq-border">
                  <td className="py-1.5 font-mono">{d.label}</td>
                  <td className="text-right tabular-nums">{d.verified}</td>
                  <td className={cx('text-right tabular-nums', d.rejected > 0 && 'text-vq-err')}>{d.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-60" role="img" aria-label="Verified reads and rejected attempts per 5 minutes over the last hour">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="rgb(var(--vq-border))" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'rgb(var(--vq-muted))' }} interval="preserveStartEnd" minTickGap={16} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'rgb(var(--vq-muted))' }} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgb(var(--vq-lavender-100))', radius: 6 }} />
              <Bar dataKey="verified" stackId="a" fill={VERIFIED} stroke="rgb(var(--vq-surface))" strokeWidth={2} radius={[4, 4, 4, 4]} isAnimationActive={false} />
              <Bar dataKey="rejected" stackId="a" fill={REJECTED} stroke="rgb(var(--vq-surface))" strokeWidth={2} radius={[4, 4, 4, 4]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
