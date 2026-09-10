import { motion } from 'framer-motion'
import {
  AtSign, QrCode, MessageCircle, Banknote, Layers, ArrowLeftRight, Repeat, Handshake, Activity,
} from 'lucide-react'
import { Reveal, RevealGroup, staggerItem } from './Reveal'

const GROUPS = [
  {
    label: 'Pay',
    items: [
      { icon: AtSign, title: 'Username Payments', desc: 'Send USDC using a .arc username instead of copying a long wallet address.' },
      { icon: QrCode, title: 'Receive & QR', desc: 'Create a payment request and let another user pay directly into your wallet.' },
      { icon: MessageCircle, title: 'Chat Payments', desc: 'Send payments directly inside conversations.' },
      { icon: Banknote, title: 'Bulk Payments', desc: 'Send USDC to multiple recipients in one flow — payroll, contributors, or group payouts.' },
    ],
  },
  {
    label: 'Move',
    items: [
      { icon: Layers, title: 'Multichain Claim', desc: 'Claim supported crosschain USDC into your Arc wallet.' },
      { icon: ArrowLeftRight, title: 'Multichain Transfer', desc: 'Move supported assets across supported networks.' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { icon: Repeat, title: 'Swap on Arc', desc: 'Exchange supported assets directly on Arc with a quoted rate before you confirm.' },
      { icon: Handshake, title: 'P2P', desc: 'Buy and sell USDC directly with other users, protected by an escrow-based flow.' },
      { icon: Activity, title: 'Activity', desc: 'Track every payment and transaction in one place.' },
    ],
  },
]

export function FeaturesGrid() {
  return (
    <section id="features" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand">Everything in one app</p>
        <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">
          Built for how people actually pay
        </h2>
        <p className="mt-4 text-[15.5px] leading-relaxed text-text-secondary">
          A payment app first — with the tools to move, swap, and trade USDC when you need them.
        </p>
      </Reveal>

      <div className="mt-14 flex flex-col gap-12 sm:mt-16">
        {GROUPS.map(group => (
          <div key={group.label}>
            <Reveal className="mb-5">
              <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-text-muted">{group.label}</p>
            </Reveal>
            <RevealGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
              {group.items.map(f => (
                <motion.div
                  key={f.title}
                  variants={staggerItem}
                  whileHover={{ y: -4, boxShadow: '0 16px 40px -12px rgba(0,0,0,0.18)' }}
                  transition={{ type: 'spring', stiffness: 280, damping: 22 }}
                  className="group flex flex-col gap-4 rounded-[20px] border border-border bg-surface p-6 shadow-elevation-1"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/12 text-brand transition-colors group-hover:bg-brand group-hover:text-white">
                    <f.icon size={21} />
                  </div>
                  <div>
                    <h3 className="text-[16px] font-bold text-text-primary">{f.title}</h3>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-secondary">{f.desc}</p>
                  </div>
                </motion.div>
              ))}
            </RevealGroup>
          </div>
        ))}
      </div>
    </section>
  )
}
