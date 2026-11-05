import { useRef, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { motion, useInView, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

/** Smooth spring used by every scroll-linked animation. */
export const SCROLL_SPRING = { stiffness: 120, damping: 24, restDelta: 0.001 }
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

export function LogoIcon({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M 128.005 191.173 C 128.448 156.208 156.93 128 192 128 L 192 64 L 128 64 C 128 99.346 99.346 128 64 128 L 64 192 L 128 192 Z M 192 256 L 64 256 C 28.654 256 0 227.346 0 192 L 0 64 L 64 64 L 64 0 L 192 0 C 227.346 0 256 28.654 256 64 L 256 192 L 192 192 Z" />
    </svg>
  )
}

/** The one container used by every section and the nav: near full width, small side gutters. */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-[1680px] px-4 md:px-6', className)}>{children}</div>
}

export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    // Top padding only, so two adjacent sections are never more than ~96px apart.
    <section id={id} className={cn('relative pt-16 md:pt-24 scroll-mt-20', className)}>
      {children}
    </section>
  )
}

export function FadeUp({ children, className, delay = 0, y = 24 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, delay, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  )
}

/** eyebrow -> heading -> body */
export function SectionHeading({
  eyebrow,
  title,
  body,
  className,
  align = 'left',
  dark = false,
}: {
  eyebrow?: string
  title: ReactNode
  body?: ReactNode
  className?: string
  align?: 'left' | 'center'
  dark?: boolean
}) {
  return (
    <FadeUp className={cn(align === 'center' && 'text-center mx-auto', className)}>
      {eyebrow && <span className={cn('block text-sm mb-4', dark ? 'text-vq-lav-500' : 'text-vq-muted')}>{eyebrow}</span>}
      <h2
        className={cn(
          'text-[36px] sm:text-[40px] md:text-[56px] lg:text-[64px] font-medium leading-[1.02] tracking-hero',
          dark ? 'text-white' : 'text-vq-black',
        )}
      >
        {title}
      </h2>
      {body && (
        <p className={cn('mt-5 text-[17px] md:text-[18px] leading-relaxed max-w-[560px]', align === 'center' && 'mx-auto', dark ? 'text-white/60' : 'text-vq-muted')}>
          {body}
        </p>
      )}
    </FadeUp>
  )
}

const focus = 'outline-none focus-visible:ring-2 focus-visible:ring-vq-lav-500 focus-visible:ring-offset-2'

/** The landing's pill: label + circle arrow. `light` = white pill with black circle. */
export function PillLink({
  href,
  children,
  light = false,
  size = 'md',
  className,
}: {
  href: string
  children: ReactNode
  light?: boolean
  size?: 'md' | 'lg'
  className?: string
}) {
  const external = href.startsWith('http')
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(
        'group inline-flex items-center gap-3 rounded-full font-medium transition-colors duration-200 pl-7 pr-2 py-2',
        size === 'lg' ? 'text-base md:text-lg' : 'text-base',
        light ? 'bg-white text-vq-ink hover:bg-vq-lav-100' : 'bg-black text-white hover:bg-gray-800',
        focus,
        className,
      )}
    >
      <span>{children}</span>
      <span className={cn('rounded-full p-2 flex items-center justify-center', light ? 'bg-black' : 'bg-white')}>
        <ArrowRight
          className={cn('w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5', size === 'lg' && 'md:w-5 md:h-5', light ? 'text-white' : 'text-black')}
          aria-hidden="true"
        />
      </span>
    </a>
  )
}

export const focusRing = focus

/**
 * CSS marquee: renders children twice and slides -50%. Pauses on hover and while off-screen;
 * reduced motion stops it entirely (see .vq-marquee in index.css).
 */
export function Marquee({
  children,
  duration = 30,
  reverse = false,
  className,
  trackClassName,
  fade = true,
}: {
  children: ReactNode
  duration?: number
  reverse?: boolean
  className?: string
  trackClassName?: string
  fade?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '100px' })
  const reduce = useReducedMotion()
  return (
    <div ref={ref} className={cn('overflow-hidden', fade && 'vq-fade-x', className)}>
      <div
        className={cn('vq-marquee flex w-max', trackClassName)}
        style={{
          animationDuration: `${duration}s`,
          animationDirection: reverse ? 'reverse' : 'normal',
          animationPlayState: inView && !reduce ? undefined : 'paused',
        }}
      >
        <div className="flex shrink-0">{children}</div>
        <div className="flex shrink-0" aria-hidden="true">{children}</div>
      </div>
    </div>
  )
}
