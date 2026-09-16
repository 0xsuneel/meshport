import { motion } from 'framer-motion'
import { ArrowDown, QrCode, MessageCircle, Activity } from 'lucide-react'
import { Reveal } from './Reveal'

const POINTS = [
  { icon: QrCode, label: 'Receive by QR', desc: 'Share a QR or payment link and get paid directly into your wallet.' },
  { icon: MessageCircle, label: 'Chat payments', desc: 'Send USDC without leaving a conversation.' },
  { icon: Activity, label: 'Payment activity', desc: 'Every payment you send or receive, tracked in one place.' },
]

export function PaymentStory() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-10">
        <Reveal>
          <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand">Pay by username</p>
          <h2 className="mt-3 text-[28px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[36px]">
            Payments without the wallet gymnastics.
          </h2>
          <p className="mt-4 max-w-[460px] text-[15.5px] leading-relaxed text-text-secondary">
            No long addresses to copy. Send USDC to a MeshPort username and manage the payment directly inside MeshPort.
          </p>

          <div className="mt-10 flex flex-col gap-5">
            {POINTS.map(p => (
              <div key={p.label} className="flex items-start gap-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand/12 text-brand">
                  <p.icon size={18} />
                </div>
                <div>
                  <p className="text-[14.5px] font-bold text-text-primary">{p.label}</p>
                  <p className="mt-0.5 text-[13.5px] leading-relaxed text-text-secondary">{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1} className="flex justify-center">
          <div
            className="flex w-full max-w-[360px] flex-col items-center gap-3 rounded-[24px] border border-border bg-surface p-8"
            style={{ boxShadow: '0 20px 60px -20px rgba(0,0,0,0.18)' }}
          >
            <div className="flex w-full items-center justify-between rounded-2xl border border-border bg-bg px-5 py-4">
              <span className="text-[13px] font-medium text-text-secondary">From</span>
              <span className="text-[15px] font-bold text-brand">sunil.arc</span>
            </div>

            <motion.div
              animate={{ y: [0, 4, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              className="flex flex-col items-center gap-1 py-1"
            >
              <ArrowDown size={18} className="text-text-muted" />
              <span className="text-[22px] font-extrabold tracking-tight text-text-primary">10 USDC</span>
            </motion.div>

            <div className="flex w-full items-center justify-between rounded-2xl border border-border bg-bg px-5 py-4">
              <span className="text-[13px] font-medium text-text-secondary">To</span>
              <span className="text-[15px] font-bold text-brand">john.arc</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
