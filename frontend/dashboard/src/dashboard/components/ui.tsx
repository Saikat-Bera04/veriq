import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { ArrowRight, Check, Copy, RefreshCw } from 'lucide-react'
import { truncateMiddle } from '../lib/format'

// The lavender 3D image from the landing's "Proofs, not promises" card. No new images.
export const LANDING_IMAGE =
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260423_164207_f243351d-ed59-48ec-83a0-a5e996bdbe3c.png&w=1280&q=85'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export { cx }

// ---------------------------------------------------------------- motion

export const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
}
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
}

export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={staggerParent} initial="hidden" animate="visible" className={className}>
      {children}
    </motion.div>
  )
}

// ---------------------------------------------------------------- surfaces

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <motion.section
      variants={staggerItem}
      className={cx(
        'bg-vq-surface border border-vq-border rounded-card shadow-card min-w-0',
        padded && 'p-6 md:p-8',
        className,
      )}
    >
      {children}
    </motion.section>
  )
}

/** The dark "feature card" from the landing, one per page for the key number. */
export function HeroPanel({
  children,
  className,
  image = false,
}: {
  children: ReactNode
  className?: string
  image?: boolean
}) {
  return (
    <motion.section
      variants={staggerItem}
      className={cx('relative overflow-hidden bg-vq-aubergine text-white rounded-card p-6 md:p-8 min-w-0', className)}
    >
      {image && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -bottom-20 w-64 h-64 md:w-96 md:h-96 rounded-full opacity-35 md:opacity-60 mix-blend-screen"
          style={{
            backgroundImage: `url(${LANDING_IMAGE})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            maskImage: 'radial-gradient(circle, black 35%, transparent 70%)',
            WebkitMaskImage: 'radial-gradient(circle, black 35%, transparent 70%)',
          }}
        />
      )}
      <div className="relative">{children}</div>
    </motion.section>
  )
}

export function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <h2 className="text-xl md:text-2xl font-medium tracking-h3 text-vq-ink">{children}</h2>
      {aside}
    </div>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="text-sm text-vq-muted">{children}</div>
}

// ---------------------------------------------------------------- buttons

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }

/** Landing primary: black pill with the white circle arrow. */
export function PrimaryButton({ children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled}
      className={cx(
        'vq-focus group inline-flex items-center gap-3 bg-vq-black text-white text-base font-medium pl-6 pr-1.5 py-1.5 rounded-full',
        'hover:bg-gray-800 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
    >
      <span>{children}</span>
      <span className="bg-white rounded-full p-2 flex items-center justify-center">
        <ArrowRight className="w-4 h-4 text-black transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
    </button>
  )
}

export function PrimaryLink({ href, children, invert = false }: { href: string; children: ReactNode; invert?: boolean }) {
  return (
    <a
      href={href}
      className={cx(
        'vq-focus group inline-flex items-center gap-3 text-base font-medium pl-6 pr-1.5 py-1.5 rounded-full transition-colors duration-200',
        invert ? 'bg-white text-black hover:bg-vq-lav-100' : 'bg-vq-black text-white hover:bg-gray-800',
      )}
    >
      <span>{children}</span>
      <span className={cx('rounded-full p-2 flex items-center justify-center', invert ? 'bg-vq-black' : 'bg-white')}>
        <ArrowRight className={cx('w-4 h-4', invert ? 'text-white' : 'text-black')} aria-hidden="true" />
      </span>
    </a>
  )
}

/** White pill with border. */
export function SecondaryButton({ children, className, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx(
        'vq-focus inline-flex items-center gap-2 bg-vq-surface text-vq-ink text-sm font-medium px-4 py-2 rounded-full border border-vq-border',
        'hover:border-vq-lav-300 hover:bg-vq-lav-100/50 transition-colors duration-200 disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- chips & badges

type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'lav' | 'dark'
const TONES: Record<Tone, string> = {
  neutral: 'bg-white/55 border-vq-ink/10 text-vq-ink',
  ok: 'bg-vq-ok-bg border-transparent text-vq-ok',
  warn: 'bg-vq-warn-bg border-transparent text-vq-warn',
  err: 'bg-vq-err-bg border-transparent text-vq-err',
  lav: 'bg-vq-lav-100 border-transparent text-vq-lav-700',
  dark: 'bg-white/10 border-white/15 text-white',
}

export function Chip({
  children,
  tone = 'neutral',
  dot,
  className,
  title,
}: {
  children: ReactNode
  tone?: Tone
  dot?: 'live' | 'off' | 'warn' | 'err'
  className?: string
  title?: string
}) {
  const dotClass = {
    live: 'bg-vq-live shadow-[0_0_0_3px_rgb(var(--vq-live)/0.18)]',
    off: 'bg-vq-faint',
    warn: 'bg-vq-warn shadow-[0_0_0_3px_rgb(var(--vq-warn)/0.18)]',
    err: 'bg-vq-err shadow-[0_0_0_3px_rgb(var(--vq-err)/0.18)]',
  }
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {dot && <span aria-hidden="true" className={cx('w-1.5 h-1.5 rounded-full', dotClass[dot])} />}
      {children}
    </span>
  )
}

export function SampleTag({ className }: { className?: string }) {
  return (
    <Chip tone="warn" className={className} title="Engine offline: this is sample data, not real receipts">
      Sample data
    </Chip>
  )
}

// ---------------------------------------------------------------- hashes

export function Hash({
  value,
  head = 6,
  tail = 4,
  full = false,
  className,
}: {
  value: string
  head?: number
  tail?: number
  full?: boolean
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      title={`${value} (click to copy)`}
      aria-label={`Copy ${value}`}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(value).then(() => setCopied(true))
      }}
      className={cx(
        'vq-focus group inline-flex items-center gap-1.5 font-mono text-[13px] text-vq-ink rounded-md px-1 -mx-1',
        'hover:bg-vq-lav-100 transition-colors min-w-0',
        full && 'break-all text-left',
        className,
      )}
    >
      <span className={full ? 'break-all' : 'whitespace-nowrap'}>{full ? value : truncateMiddle(value, head, tail)}</span>
      {copied ? (
        <Check className="w-3.5 h-3.5 shrink-0 text-vq-ok" aria-hidden="true" />
      ) : (
        <Copy className="w-3.5 h-3.5 shrink-0 text-vq-faint opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
      )}
      <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  )
}

// ---------------------------------------------------------------- states

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('vq-skeleton', className)} />
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-10 px-4">
      <div
        aria-hidden="true"
        className="w-28 h-28 rounded-full mb-5"
        style={{
          backgroundImage: `url(${LANDING_IMAGE})`,
          backgroundSize: '260%',
          backgroundPosition: 'center',
        }}
      />
      <h3 className="text-lg font-medium tracking-h3 text-vq-ink">{title}</h3>
      <p className="mt-1 text-sm text-vq-muted max-w-sm">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorCard({ title = 'Something went wrong', error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div role="alert" className="rounded-inner bg-vq-err-bg/60 border border-vq-err/20 p-5 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-vq-err">{title}</div>
        <p className="text-sm text-vq-muted mt-1 break-words">{message}</p>
      </div>
      {onRetry && (
        <SecondaryButton onClick={onRetry} className="self-start sm:self-auto">
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> Retry
        </SecondaryButton>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- controls

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  name,
}: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  name: string
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm text-vq-muted mb-2">{label}</legend>
      <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 p-1 rounded-full bg-vq-bg border border-vq-border">
        {options.map((opt) => {
          const active = opt === value
          return (
            <label
              key={opt}
              className={cx(
                'relative cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                active ? 'text-white' : 'text-vq-muted hover:text-vq-ink',
              )}
            >
              <input
                type="radio"
                name={name}
                value={opt}
                checked={active}
                onChange={() => onChange(opt)}
                className="peer sr-only"
              />
              {active && (
                <motion.span
                  layoutId={`seg-${name}`}
                  className="absolute inset-0 rounded-full bg-vq-black"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-vq-lav-500">
                {opt}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

// ---------------------------------------------------------------- numbers & time

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** Number that slides up when it changes (finalized block ticker). */
export function TickingNumber({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cx('relative inline-flex overflow-hidden tabular-nums', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: '100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-100%', opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
