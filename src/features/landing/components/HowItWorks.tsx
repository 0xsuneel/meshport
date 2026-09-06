import { motion } from 'framer-motion'
import { Wallet, ArrowDownToLine, Send, Settings2 } from 'lucide-react'
import { Reveal } from './Reveal'

const STEPS = [
  { icon: Wallet, title: 'Create your wallet', desc: 'Create your MeshPort wallet and protect it with your device.' },
  { icon: ArrowDownToLine, title: 'Fund it', desc: 'Receive USDC directly, or claim supported crosschain funds into your Arc wallet.' },
  { icon: Send, title: 'Pay', desc: 'Send USDC by username, QR, or directly inside chat.' },
  { icon: Settings2, title: 'Manage', desc: 'Swap, trade P2P, make bulk payments, and track your activity.' },
]

const EASE = [0.16, 1, 0.3, 1] as const

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand">How it works</p>
        <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">
          From zero to your first payment
        </h2>
      </Reveal>

      <div className="relative mt-16">
        {/* Connecting line — desktop only, animates in on scroll */}
        <div className="absolute left-0 right-0 top-6 hidden h-px lg:block" style={{ background: 'var(--border)' }}>
          <motion.div
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 1, ease: EASE }}
            style={{ height: 1, background: 'var(--brand)', transformOrigin: 'left', opacity: 0.35 }}
          />
        </div>

        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.1} className="flex flex-col items-center text-center lg:items-start lg:text-left">
              <div className="relative">
                <div
                  className="relative z-10 flex h-12 w-12 items-center justify-center rounded-2xl border-2"
                  style={{ background: 'var(--bg)', borderColor: 'var(--brand)' }}
                >
                  <s.icon size={20} className="text-brand" />
                </div>
                <div
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-bold text-white"
                  style={{ background: 'var(--brand)' }}
                >
                  {i + 1}
                </div>
              </div>
              <h3 className="mt-4 text-[16px] font-bold text-text-primary">{s.title}</h3>
              <p className="mt-2 max-w-[240px] text-[13.5px] leading-relaxed text-text-secondary">{s.desc}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
