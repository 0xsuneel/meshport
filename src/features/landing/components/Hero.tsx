import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, FileText } from 'lucide-react'
import { NetworkBackground } from './NetworkBackground'
import { PayByName } from './PayByName'

const EASE = [0.16, 1, 0.3, 1] as const

export function Hero() {
  const navigate = useNavigate()

  return (
    <section id="top" className="scroll-mt-24" style={{ position: 'relative', overflow: 'hidden' }}>
      <NetworkBackground className="hidden sm:block" />

      <div className="relative mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] items-center gap-14 px-5 pb-20 pt-16 sm:px-8 sm:pb-28 sm:pt-24 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-32 lg:pt-28">
        <div>
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
            className="mt-6 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary sm:text-[18px]"
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
              className="group flex items-center justify-center gap-2 rounded-2xl bg-brand px-7 py-4 text-[16px] font-bold text-white transition-transform active:scale-[0.98] sm:w-auto"
            >
              Launch MeshPort
              <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
            </button>
            <a
              href="#how-it-works"
              className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-7 py-4 text-[16px] font-semibold text-text-primary transition-colors hover:border-brand/40"
            >
              <FileText size={16} />
              See how it works
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.35 }}
            className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px] text-text-secondary"
          >
            <span>Self-custodial. Your key never leaves your device.</span>
            <span className="rounded-full bg-warning/10 px-2.5 py-1 text-[13px] font-semibold text-warning">
              Arc Testnet
            </span>
          </motion.div>
        </div>

        <div className="flex justify-center lg:justify-end">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.15, ease: EASE }}
            className="flex w-full justify-center lg:justify-end"
          >
            <PayByName />
          </motion.div>
        </div>
      </div>
    </section>
  )
}
