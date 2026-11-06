import { Fragment, useState } from 'react'
import { motion, useMotionValueEvent, useScroll } from 'framer-motion'
import { cn } from '@/lib/utils'
import { GITHUB_URL } from './assets'
import { Container, LogoIcon, focusRing } from './primitives'

const LINKS = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'SDK', href: '#core-features' },
  { label: 'Delegation Guard', href: '/app/delegation-guard' },
  { label: 'Attack lab', href: '/app/attack-lab' },
  { label: 'Docs', href: '#stack' },
  { label: 'GitHub', href: GITHUB_URL },
]

export function Navbar() {
  const { scrollY } = useScroll()
  const [scrolled, setScrolled] = useState(false)
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 40))

  return (
    <nav className="fixed top-0 inset-x-0 z-50" aria-label="Main">
      {/* Background fades in past 40px: opacity only */}
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-white/80 backdrop-blur-md border-b border-vq-border"
        initial={false}
        animate={{ opacity: scrolled ? 1 : 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      />
      <Container className="relative flex h-[72px] items-center justify-between gap-6">
        <a href="/" className={cn('flex items-center gap-3 rounded-lg', focusRing)} aria-label="Veriq home">
          <LogoIcon className="w-7 h-7 text-black" />
          <span className="text-2xl font-medium tracking-tight text-black">Veriq</span>
        </a>

        <div className="hidden lg:flex items-center gap-7 text-base text-gray-700 font-medium">
          {LINKS.map((l, i) => (
            <Fragment key={l.label}>
              {i > 0 && <span className="text-gray-400 select-none" aria-hidden="true">·</span>}
              <a
                href={l.href}
                {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={cn('rounded hover:text-black transition-colors duration-200', focusRing)}
              >
                {l.label}
              </a>
            </Fragment>
          ))}
        </div>

        <a
          href="/app"
          className={cn(
            'bg-black text-white text-sm md:text-base font-medium px-5 md:px-7 py-2.5 rounded-full hover:bg-gray-800 transition-colors duration-200',
            focusRing,
          )}
        >
          Open Dashboard
        </a>
      </Container>
    </nav>
  )
}
