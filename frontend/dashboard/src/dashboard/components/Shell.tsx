import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  ArrowLeft,
  CodeXml,
  Globe,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Satellite,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  Swords,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { LogoIcon } from '@/components/landing/primitives'
import { currentChain } from '../lib/chain'
import { ENGINE_DISPLAY, getEngineDisplayAddress, useHealth } from '../lib/engine'
import { isAnonEnabled, startAnon } from '../lib/anon'
import { AnonBadge } from './AnonBadge'
import { startBrowserLightClient } from '../lib/lightclient'
import { formatNumber } from '../lib/format'
import { Chip, SampleTag, TickingNumber, cx } from './ui'
import { ReceiptDrawer } from './ReceiptDrawer'
import { EngineStatus as SdkEngineStatus } from 'veriq-client/react'

interface NavItem {
  to: string
  label: string
  short: string
  title: string
  Icon: LucideIcon
}

export const NAV: NavItem[] = [
  { to: '/app', label: 'Overview', short: 'Overview', title: 'Overview', Icon: LayoutDashboard },
  { to: '/app/feed', label: 'Live feed', short: 'Feed', title: 'Live feed', Icon: Activity },
  { to: '/app/delegation-guard', label: 'Delegation guard', short: 'Guard', title: 'EIP-7702 Delegation Guard', Icon: ShieldAlert },
  { to: '/app/providers', label: 'Providers', short: 'Providers', title: 'Providers', Icon: Server },
  { to: '/app/light-client', label: 'Light client', short: 'Light', title: 'Light client', Icon: Satellite },
  { to: '/app/attack-lab', label: 'Attack lab', short: 'Attack', title: 'Attack lab', Icon: Swords },
  { to: '/app/policy', label: 'Policy', short: 'Policy', title: 'Policy playground', Icon: SlidersHorizontal },
  { to: '/app/developers', label: 'Developers', short: 'Dev', title: 'Developers', Icon: CodeXml },
]

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function writeSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // storage unavailable; state stays in memory
  }
}

function EngineStatus({ compact }: { compact: boolean }) {
  const { data } = useHealth()
  const online = data?.source === 'live'
  const displayAddress = getEngineDisplayAddress()
  const label = online ? `Engine online · ${displayAddress}` : data ? 'Engine offline' : 'Checking engine…'
  if (compact) {
    return (
      <span title={label} className="flex justify-center">
        <span className={cx('w-2.5 h-2.5 rounded-full', online ? 'bg-vq-live shadow-[0_0_0_4px_rgb(var(--vq-live)/0.18)]' : 'bg-vq-faint')} />
        <span className="sr-only">{label}</span>
      </span>
    )
  }
  // The SDK component, fed from the dashboard's health query (no second poller).
  return <SdkEngineStatus health={online ? data.data : null} address={displayAddress} className="w-full" />
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  // Full width at >=1024px unless collapsed; icons only between 768 and 1023px.
  const showLabels = collapsed ? 'hidden' : 'hidden lg:inline'
  return (
    <aside
      className={cx(
        'hidden md:flex fixed inset-y-0 left-0 z-30 flex-col bg-vq-surface border-r border-vq-border transition-[width] duration-200',
        collapsed ? 'w-[76px]' : 'w-[76px] lg:w-[260px]',
      )}
    >
      <div className={cx('flex items-center h-20 px-5 gap-3', collapsed ? 'justify-center' : 'justify-center lg:justify-between')}>
        <a href="/" className="vq-focus flex items-center gap-3 rounded-lg" aria-label="Veriq home">
          <LogoIcon className="w-7 h-7 text-black" />
          <span className={cx('text-2xl font-medium tracking-tight text-black', showLabels)}>Veriq</span>
        </a>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          className={cx('vq-focus p-1.5 rounded-lg text-vq-muted hover:bg-vq-lav-100 hover:text-vq-ink', collapsed ? 'hidden' : 'hidden lg:block')}
        >
          <PanelLeftClose className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          className="vq-focus hidden lg:flex mx-auto mb-2 p-1.5 rounded-lg text-vq-muted hover:bg-vq-lav-100 hover:text-vq-ink"
        >
          <PanelLeftOpen className="w-5 h-5" aria-hidden="true" />
        </button>
      )}
      <nav aria-label="Dashboard" className="flex-1 px-3 space-y-1">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/app'}
            title={label}
            className={({ isActive }) =>
              cx(
                'vq-focus relative flex items-center gap-3 h-11 px-3.5 rounded-full text-[15px] font-medium transition-colors',
                collapsed ? 'justify-center' : 'justify-center lg:justify-start',
                isActive ? 'text-vq-ink' : 'text-vq-muted hover:text-vq-ink hover:bg-vq-bg',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-full bg-vq-lav-100"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                <Icon className={cx('relative w-5 h-5 shrink-0', isActive && 'text-vq-lav-700')} aria-hidden="true" />
                <span className={cx('relative', showLabels)}>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-4 space-y-3 border-t border-vq-border">
        <div className={collapsed ? 'block' : 'lg:hidden'}>
          <EngineStatus compact />
        </div>
        <div className={collapsed ? 'hidden' : 'hidden lg:block'}>
          <EngineStatus compact={false} />
        </div>
        <a
          href="/"
          title="Back to site"
          className={cx(
            'vq-focus flex items-center gap-2 text-sm text-vq-muted hover:text-vq-ink rounded-lg px-1 py-1',
            collapsed ? 'justify-center' : 'justify-center lg:justify-start',
          )}
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span className={showLabels}>Back to site</span>
        </a>
      </div>
    </aside>
  )
}

function BottomTabs() {
  return (
    <nav
      aria-label="Dashboard"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-vq-surface/95 backdrop-blur border-t border-vq-border pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid grid-cols-8">
        {NAV.map(({ to, label, short, Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={to === '/app'}
              aria-label={label}
              className={({ isActive }) =>
                cx(
                  'vq-focus flex flex-col items-center gap-1 pt-2.5 pb-2 text-[10px] font-medium',
                  isActive ? 'text-vq-lav-700' : 'text-vq-muted',
                )
              }
            >
              <Icon className="w-5 h-5" aria-hidden="true" />
              <span className="truncate max-w-full px-0.5">{short}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function TopBar({ title }: { title: string }) {
  const { data } = useHealth()
  const health = data?.data
  const mock = data?.source === 'mock'
  const root = health?.rootSource
  const finalized = health?.lightClient.finalizedNumber
  return (
    <header className="sticky top-0 z-20 bg-vq-bg/85 backdrop-blur border-b border-vq-border/60">
      <div className="px-4 md:px-8 py-4 md:py-5 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
        <div className="flex items-center gap-3 min-w-0">
          <a href="/" className="md:hidden vq-focus rounded-lg" aria-label="Back to site">
            <LogoIcon className="w-6 h-6 text-black" />
          </a>
          <h1 className="text-2xl md:text-[32px] leading-tight font-medium tracking-hero text-vq-ink truncate">{title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Chip>
            <Globe className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="capitalize">{currentChain().name}</span>
          </Chip>
          {root === 'local-light-client' && <Chip tone="ok" dot="live">Local light client</Chip>}
          {root === 'fixture' && <Chip tone="lav">Fixture root</Chip>}
          {root === 'untrusted-rpc' && (
            <Chip tone="warn" dot="warn">
              DEV MODE — unverified
            </Chip>
          )}
          <Chip title="Latest finalized block from the light client">
            <span className="text-vq-muted">Finalized</span>
            {finalized != null ? (
              <TickingNumber value={`#${formatNumber(finalized)}`} className="font-mono" />
            ) : (
              <span>—</span>
            )}
          </Chip>
          {mock && <SampleTag />}
          <AnonBadge />
        </div>
      </div>
    </header>
  )
}

const BANNER_KEY = 'vq-mock-banner-dismissed'

function MockBanner() {
  const { data } = useHealth()
  const [dismissed, setDismissed] = useState(() => readSession(BANNER_KEY) === '1')
  const show = data?.source === 'mock' && !dismissed
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden"
        >
          <div role="status" className="mx-4 md:mx-8 mt-4 flex items-center gap-3 rounded-inner bg-vq-warn-bg text-vq-warn px-4 py-3 text-sm">
            <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">
              <strong className="font-semibold">Engine offline — showing sample data.</strong>{' '}
              <span className="text-vq-ink/70">Start the engine on {ENGINE_DISPLAY} and this page switches to live receipts.</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setDismissed(true)
                writeSession(BANNER_KEY, '1')
              }}
              aria-label="Dismiss sample data banner"
              className="vq-focus p-1 rounded-full hover:bg-vq-warn/10"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('vq-sidebar-collapsed') === '1'
  } catch {
    return false
  }
}

export function Shell() {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const item = NAV.find((n) => n.to === location.pathname) ?? NAV[0]
  const receiptId = params.get('receipt')

  useEffect(() => {
    document.title = `${item.title} · Veriq`
  }, [item.title])

  // Join Nox as soon as /app loads, so the first read does not wait for it. startAnon is
  // idempotent: StrictMode's double effect and hot reloads reuse the one worker. Helios in the
  // browser (S4) starts once Nox is ready and syncs through it; also one per page.
  useEffect(() => {
    if (isAnonEnabled()) {
      void startAnon()
      void startBrowserLightClient()
    }
  }, [])

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('vq-sidebar-collapsed', c ? '0' : '1')
      } catch {
        // ignore
      }
      return !c
    })
  }

  return (
    <div className="vq-root min-h-screen bg-vq-bg text-vq-ink font-sans overflow-x-hidden">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className={cx('min-w-0 transition-[padding] duration-200', collapsed ? 'md:pl-[76px]' : 'md:pl-[76px] lg:pl-[260px]')}>
        <TopBar title={item.title} />
        <MockBanner />
        <main className="px-4 md:px-8 py-6 md:py-8 pb-28 md:pb-12 max-w-[1600px]">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
      <BottomTabs />
      <ReceiptDrawer
        id={receiptId}
        onClose={() => {
          const next = new URLSearchParams(params)
          next.delete('receipt')
          setParams(next, { replace: true })
        }}
      />
    </div>
  )
}
