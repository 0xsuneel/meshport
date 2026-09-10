import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus } from 'lucide-react'
import { Reveal } from './Reveal'

const FAQS = [
  {
    q: 'Is MeshPort self-custodial?',
    a: 'MeshPort is designed around self-custody. If you create or import a wallet directly, your private key is generated on your device and never sent anywhere. Signing in with Google or email uses a recoverable model instead, so you can access your wallet without a seed phrase.',
  },
  {
    q: 'How are Google/email wallets secured?',
    a: 'Wallets created via Google or email sign-in use envelope encryption: your key is encrypted with a wallet-specific key, which is itself encrypted under a server-held master key, before anything touches the database. MeshPort never stores your key in plaintext, and every access is authenticated, rate-limited, and logged.',
  },
  {
    q: 'What is Arc?',
    a: 'Arc is a Layer-1 blockchain built by Circle, purpose-built for stablecoin payments. USDC is Arc’s native gas token, and the network is designed for fast, low-cost, EVM-compatible transactions.',
  },
  {
    q: 'How do username payments work?',
    a: 'Every MeshPort wallet has a .arc username. Send USDC to that username instead of a long wallet address — no copying or verifying a hex string before you pay.',
  },
  {
    q: 'What assets does MeshPort support?',
    a: 'MeshPort is USDC-native, with support for EURC and cirBTC for swaps on Arc. You can also claim supported USDC sent from other chains into your Arc wallet.',
  },
  {
    q: 'How does Multichain Claim work?',
    a: 'When someone sends you USDC from a supported chain, it lands in a claimable state via Circle’s crosschain infrastructure. Multichain Claim pulls it into your Arc balance in one action.',
  },
  {
    q: 'Does MeshPort use Circle infrastructure?',
    a: 'Yes. MeshPort runs on Arc, Circle’s stablecoin-native network, and uses Circle’s tooling for crosschain USDC movement. This isn’t a claim of Circle endorsement or partnership.',
  },
  {
    q: 'How fast are Arc transactions?',
    a: 'Arc is built for sub-second finality on native transactions. Crosschain transfers take longer, since they wait on burn-and-mint confirmation from the source chain before funds are claimable.',
  },
  {
    q: 'Is the P2P marketplace safe?',
    a: 'P2P trades run through an escrow flow — funds are held until both sides confirm the trade, so neither party can walk away with the other’s money mid-trade.',
  },
  {
    q: 'Is MeshPort currently on Arc Testnet?',
    a: 'Yes. MeshPort currently runs on Arc Testnet. Balances, transfers, and assets in the app today are testnet assets, not mainnet funds.',
  },
  {
    q: 'How is my account secured?',
    a: 'A passcode is required by default, with optional Face ID / fingerprint unlock backed by your device’s platform authenticator. For self-custodial (create/import) wallets, your key never leaves your device.',
  },
]

function FAQItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Reveal delay={index * 0.04} className="border-b border-border">
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-5 text-left"
      >
        <span className="text-[15.5px] font-semibold text-text-primary">{q}</span>
        <motion.span
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 22 }}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand/12 text-brand"
        >
          <Plus size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            style={{ overflow: 'hidden' }}
          >
            <p className="pb-5 pr-10 text-[14px] leading-relaxed text-text-secondary">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Reveal>
  )
}

export function FAQSection() {
  return (
    <section id="faq" className="scroll-mt-24 mx-auto max-w-3xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="text-center">
        <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand">FAQ</p>
        <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">
          Questions, answered
        </h2>
      </Reveal>

      <div className="mt-12 border-t border-border">
        {FAQS.map((f, i) => (
          <FAQItem key={f.q} q={f.q} a={f.a} index={i} />
        ))}
      </div>
    </section>
  )
}
