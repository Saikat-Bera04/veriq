import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'framer-motion'
import '../VeriqFooter.css'
import { DOCS_URL, FOOTER_POSTER, FOOTER_VIDEO, GITHUB_URL } from './landing/assets'
import { SCROLL_SPRING } from './landing/primitives'
import { ENGINE_CHECKING, ENGINE_OFFLINE, footerStatus, type FooterStatus } from './footerStatus'

const DOT: Record<FooterStatus['tone'], [string, string]> = {
  ok: ['#2fb36a', 'rgba(47, 179, 106, 0.18)'],
  warn: ['#d99a1e', 'rgba(217, 154, 30, 0.18)'],
  off: ['#9ca3af', 'rgba(156, 163, 175, 0.18)'],
}

const README = `${GITHUB_URL}/blob/main/README.md`

export interface VeriqFooterProps {
  className?: string
}

export interface FooterLink {
  label: string
  href: string
}

export interface FooterColumn {
  title: string
  ariaLabel: string
  isMenu?: boolean
  links: FooterLink[]
}

const MENU_COLUMN: FooterColumn = {
  title: 'Menu',
  ariaLabel: 'Menu',
  isMenu: true,
  links: [
    { label: 'How it works', href: '#how-it-works' },
    { label: 'Attack lab', href: '/app/attack-lab' },
    { label: 'Docs', href: DOCS_URL },
    { label: 'SDK', href: '#core-features' },
    { label: 'GitHub', href: GITHUB_URL },
  ],
}

const ESSENTIALS_COLUMN: FooterColumn = {
  title: 'Essentials',
  ariaLabel: 'Essentials',
  links: [
    { label: 'Quick start', href: `${README}#quick-start` },
    { label: 'Trust receipts', href: `${README}#trust-receipt` },
    { label: 'Security model', href: `${README}#threat-model` },
    { label: 'Honest limits', href: `${README}#honest-limits` },
    { label: 'Judging Q&A', href: `${GITHUB_URL}/blob/main/docs/judging-qa.md` },
  ],
}

const BUILT_WITH_COLUMN: FooterColumn = {
  title: 'Built with',
  ariaLabel: 'Built with',
  links: [
    { label: 'Helios', href: 'https://github.com/a16z/helios' },
    { label: 'alloy', href: 'https://github.com/alloy-rs/alloy' },
    { label: 'axum', href: 'https://github.com/tokio-rs/axum' },
    { label: 'viem', href: 'https://viem.sh' },
    { label: 'Foundry', href: 'https://getfoundry.sh' },
    { label: 'Vite', href: 'https://vite.dev' },
  ],
}

export const VeriqFooter: React.FC<VeriqFooterProps> = ({ className = '' }) => {
  const [status, setStatus] = useState<FooterStatus>(ENGINE_CHECKING)
  const footerRef = useRef<HTMLElement>(null)
  const reduce = useReducedMotion()
  // Giant wordmark rises 40px and fades in as the footer enters.
  const { scrollYProgress } = useScroll({ target: footerRef, offset: ['start end', 'end end'] })
  const enter = useSpring(scrollYProgress, SCROLL_SPRING)
  const wordY = useTransform(enter, [0, 1], [40, 0])
  const wordOpacity = useTransform(enter, [0, 0.8], [0, 1])

  useEffect(() => {
    let isMounted = true
    const checkHealth = async () => {
      try {
        // Same-origin proxy to the engine's GET /health (see vite.config.ts).
        // A degraded engine answers 503 with its health body: read it either way.
        const res = await fetch('/engine/health', { method: 'GET', signal: AbortSignal.timeout(4000) })
        const data: unknown = await res.json().catch(() => null)
        if (isMounted) setStatus(footerStatus(data))
      } catch {
        if (isMounted) setStatus(ENGINE_OFFLINE)
      }
    }

    checkHealth()
    const interval = setInterval(checkHealth, 10000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [])

  return (
    <footer ref={footerRef} className={`footer ${className}`.trim()}>
      {/* 1. Stage and looping video */}
      <div className="footer__stage" aria-hidden="true">
        <video
          className="footer__video"
          src={FOOTER_VIDEO}
          poster={FOOTER_POSTER}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
        />
      </div>

      {/* 2. Frosted Glass Wordmark */}
      <motion.p
        className="footer__wordmark"
        aria-hidden="true"
        style={reduce ? { x: '-50%' } : { x: '-50%', y: wordY, opacity: wordOpacity }}
      >
        Veriq
      </motion.p>

      {/* 3. Fog layer */}
      <div className="footer__fog" aria-hidden="true" />

      {/* 4. Content Grid */}
      <div className="footer__content">
        {/* Brand Block */}
        <div className="brand">
          <a className="brand__logo" href="/" aria-label="Veriq home">
            <span className="brand__mark" />
            Veriq
          </a>

          <h2 className="brand__title">The verified RPC for Ethereum</h2>

          <p className="brand__text">
            Veriq runs on your machine, syncs a Helios light client, and only returns values it can prove.
          </p>

          <a className="brand__cta" href="/app">
            <ArrowRight className="w-3.5 h-3.5 text-white" aria-hidden="true" />
            Open Dashboard
          </a>

          <p className="brand__copy">© 2026 Veriq — built at ETHGlobal</p>

          <ul className="brand__status" aria-label="Veriq status">
            <li className="chip">
              <span
                className="chip__dot"
                aria-hidden="true"
                style={{
                  background: DOT[status.tone][0],
                  boxShadow: `0 0 0 calc(2.5 * var(--u, 1px)) ${DOT[status.tone][1]}`,
                }}
              />
              {status.label}
            </li>
            <li className="chip">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                <path d="M20 4v7h-7" />
              </svg>
              v0.1 · ETHGlobal build
            </li>
            <li className="chip">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8Z" />
              </svg>
              Finalized-only
            </li>
          </ul>
        </div>

        {/* Column 1: Menu */}
        <nav className="col col--menu" aria-label={MENU_COLUMN.ariaLabel}>
          <h3 className="col__title">{MENU_COLUMN.title}</h3>
          <ul className="col__list">
            {MENU_COLUMN.links.map((link) => (
              <li key={link.label}>
                <a href={link.href} {...(link.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Column 2: Essentials */}
        <nav className="col" aria-label={ESSENTIALS_COLUMN.ariaLabel}>
          <h3 className="col__title">{ESSENTIALS_COLUMN.title}</h3>
          <ul className="col__list">
            {ESSENTIALS_COLUMN.links.map((link) => (
              <li key={link.label}>
                <a href={link.href} {...(link.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Column 3: Built with */}
        <nav className="col" aria-label={BUILT_WITH_COLUMN.ariaLabel}>
          <h3 className="col__title">{BUILT_WITH_COLUMN.title}</h3>
          <ul className="col__list">
            {BUILT_WITH_COLUMN.links.map((link) => (
              <li key={link.label}>
                <a href={link.href} {...(link.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  )
}

export default VeriqFooter
