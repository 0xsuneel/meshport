import { motion, type Variants } from 'framer-motion'
import type { ReactNode } from 'react'

// Shared scroll-reveal primitive for the whole landing page — one easing/
// duration/offset system everywhere instead of every section inventing its
// own, per motion-consistency (unify duration/easing tokens globally).
// easeOutExpo-ish curve + modest Y-offset is the standard premium-site
// pattern (Stripe/Linear-class sites), not a bouncy/springy entrance.
const EASE = [0.16, 1, 0.3, 1] as const

export function Reveal({
  children,
  delay = 0,
  y = 20,
  className,
}: {
  children: ReactNode
  delay?: number
  y?: number
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// Stagger container — children should be plain motion.div using
// `staggerItem` below, not their own <Reveal>, so the 70-100ms rhythm
// applies uniformly across a grid/list instead of each item re-triggering
// independently at slightly different scroll offsets.
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
}

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
}

export function RevealGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-80px' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}
