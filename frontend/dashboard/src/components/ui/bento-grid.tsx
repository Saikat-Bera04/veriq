import type { ReactNode } from 'react'
import { motion, type Variants } from 'framer-motion'
import { cn } from '@/lib/utils'

const tile: Variants = {
  hidden: { opacity: 0, y: 32 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.6, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] } }),
}

export const BentoGrid = ({ className, children }: { className?: string; children?: ReactNode }) => (
  <div className={cn('grid grid-cols-1 gap-4 md:auto-rows-[18rem] md:grid-cols-3', className)}>{children}</div>
)

export const BentoGridItem = ({
  className,
  title,
  description,
  header,
  icon,
  index = 0,
}: {
  className?: string
  title?: string | ReactNode
  description?: string | ReactNode
  header?: ReactNode
  icon?: ReactNode
  index?: number
}) => (
  <motion.article
    custom={index}
    variants={tile}
    initial="hidden"
    whileInView="visible"
    viewport={{ once: true, amount: 0.25 }}
    className={cn(
      'group/bento row-span-1 flex flex-col justify-between gap-4 rounded-[24px] border border-vq-border bg-vq-surface p-5',
      'transition-[box-shadow,border-color] duration-200 hover:border-vq-lav-300 hover:shadow-xl',
      className,
    )}
  >
    {header}
    <div className="transition-transform duration-200 group-hover/bento:translate-x-2 motion-reduce:transition-none">
      {icon}
      <h3 className="mb-1 mt-2 text-[17px] font-semibold tracking-tight text-vq-ink">{title}</h3>
      <p className="text-sm leading-relaxed text-vq-muted">{description}</p>
    </div>
  </motion.article>
)
