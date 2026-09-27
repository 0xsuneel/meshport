import { Waypoints, CircleDollarSign, ShieldCheck, Network } from 'lucide-react'
import { Reveal, RevealGroup, staggerItem } from './Reveal'
import { motion } from 'framer-motion'

const TECH = [
  { icon: Waypoints, name: 'Arc', desc: 'Stablecoin-native L1 with sub-second finality' },
  { icon: CircleDollarSign, name: 'USDC', desc: 'The native stablecoin and gas token on Arc' },
  { icon: ShieldCheck, name: 'CCTP', desc: "Circle's crosschain USDC infrastructure" },
  { icon: Network, name: 'Multichain', desc: 'Supported networks, one simpler experience' },
]

export function TrustedTech() {
  return (
    <section className="border-y border-border bg-surface/40">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-16">
        <Reveal>
          <p className="text-center text-[12.5px] font-bold uppercase tracking-[0.08em] text-text-muted">
            Built for stablecoin payments
          </p>
        </Reveal>

        <RevealGroup className="mt-8 grid grid-cols-2 gap-4 sm:mt-10 lg:grid-cols-4 lg:gap-5">
          {TECH.map(t => (
            <motion.div
              key={t.name}
              variants={staggerItem}
              whileHover={{ y: -3 }}
              transition={{ type: 'spring', stiffness: 300, damping: 22 }}
              className="flex flex-col items-center gap-3 rounded-[20px] border border-border bg-bg px-5 py-7 text-center shadow-elevation-1"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand/12">
                <t.icon size={20} color="var(--brand)" />
              </div>
              <div>
                <p className="text-[14.5px] font-bold text-text-primary">{t.name}</p>
                <p className="mt-1 text-[12px] leading-snug text-text-secondary">{t.desc}</p>
              </div>
            </motion.div>
          ))}
        </RevealGroup>
      </div>
    </section>
  )
}
