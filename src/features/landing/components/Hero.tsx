import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, FileText } from 'lucide-react'
import { NetworkBackground } from './NetworkBackground'
import { DesktopDashboardMockup } from './DashboardMockup'

const EASE = [0.16, 1, 0.3, 1] as const

export function Hero() {
  const navigate = useNavigate()

  return (
    <section id="top" className="scroll-mt-24" style={{ position: 'relative', overflow: 'hidden' }}>
      <NetworkBackground className="hidden sm:block" />

      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-16 sm:px-8 sm:pb-28 sm:pt-24 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-32 lg:pt-28">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-[12.5px] font-semibold text-text-secondary"
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
            Built on Arc &middot; USDC-native
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.05, ease: EASE }}
            className="text-[40px] font-extrabold leading-[1.08] tracking-tight text-text-primary sm:text-[52px] lg:text-[58px]"
          >
            USDC Payments,<br />Made Simple.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.12, ease: EASE }}
            className="mt-6 max-w-[520px] text-[16.5px] leading-[1.6] text-text-secondary sm:text-[18px]"
          >
            Send and receive USDC by username, move funds across supported chains, and manage your payments from one wallet built on Arc.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: EASE }}
            className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
          >
            <button
              onClick={() => navigate('/auth')}
              className="group flex items-center justify-center gap-2 rounded-2xl bg-brand px-7 py-4 text-[15px] font-bold text-white shadow-elevation-2 transition-transform active:scale-[0.98] sm:w-auto"
            >
              Launch MeshPort
              <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
            </button>
            <a
              href="#how-it-works"
              className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-7 py-4 text-[15px] font-semibold text-text-primary transition-colors hover:border-brand/40"
            >
              <FileText size={16} />
              See how it works
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.35 }}
            className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-3 text-[13px] font-medium text-text-muted"
          >
            <span>Self-custody available</span>
            <span className="h-1 w-1 rounded-full bg-text-muted/50" />
            <span>USDC-native</span>
            <span className="h-1 w-1 rounded-full bg-text-muted/50" />
            <span>Built on Arc</span>
            <span className="h-1 w-1 rounded-full bg-text-muted/50" />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning">
              Arc Testnet
            </span>
          </motion.div>
        </div>

        <div className="flex justify-center lg:justify-end">
          <DesktopDashboardMockup />
        </div>
      </div>
    </section>
  )
}
