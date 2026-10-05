import { useNavigate } from 'react-router-dom'
import { ArrowLeft, AtSign, MessageCircle, Globe2, KeyRound, ChevronRight } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── About MeshPort ─────────────────────────────────────────────────────────────
// Linked from Profile → Support → About MeshPort. What MeshPort is and why it
// exists — the feature-by-feature walkthrough lives in FeatureGuidePage.tsx.

const PILLARS = [
  {
    icon: AtSign, title: 'Pay a name, not an address',
    body: 'Every account gets a .arc username. Pay sunil.arc instead of a 42-character address — or scan a QR, or share a payment link that works even for people without the app.',
  },
  {
    icon: MessageCircle, title: 'Chat and pay in one place',
    body: 'Message friends and send money in the same conversation. Chats, photos and files are end-to-end encrypted — only you and the other person can read them.',
  },
  {
    icon: Globe2, title: 'One balance, every chain',
    body: 'Your money lives on Arc, and the Multichain Hub reaches 20+ other blockchains: bring USDC in from anywhere, or send it out to whichever chain someone needs.',
  },
  {
    icon: KeyRound, title: 'Yours alone',
    body: 'Every wallet is self-custodial — even when you sign in with Google or email. The key is made on your phone and protected by your passkey and Recovery QR. MeshPort never holds it.',
  },
]

export function AboutPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">About MeshPort</h1>
        </div>
      </div>

      <div className="px-5 pb-8 pt-2 space-y-5 lg:max-w-[760px] lg:mx-auto">
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <img src="/favicon.svg" alt="MeshPort" className="w-16 h-16" />
          <div>
            <h2 className="text-xl font-bold text-text-primary">MeshPort</h2>
            <p className="text-sm text-text-secondary mt-1">USDC Payments, Made Simple</p>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
          <p className="text-[15px] font-semibold text-text-primary leading-snug">
            Sending money should feel like sending a message.
          </p>
          <p className="text-sm text-text-secondary leading-relaxed">
            MeshPort is a payments app for digital dollars. Pick a person, type an amount, confirm — and it
            arrives in about a second, any day, any hour. No wallet addresses to copy, no gas tokens to buy,
            no exchange to sign up for, and no seed phrase you’re forced to write down.
          </p>
          <p className="text-sm text-text-secondary leading-relaxed">
            The name says what it does. <span className="text-text-primary font-medium">Mesh</span>: you’re connected
            to people and to many blockchains at once. <span className="text-text-primary font-medium">Port</span>: one
            home where your money lives, and the gateway it comes in and goes out through.
          </p>
        </div>

        <div className="space-y-3">
          {PILLARS.map(p => (
            <div key={p.title} className="bg-surface border border-border rounded-3xl p-5 flex gap-4">
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
                <p.icon className="w-5 h-5 text-accent-text" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">{p.title}</p>
                <p className="text-sm text-text-secondary leading-relaxed mt-1">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
          <p className="text-sm font-semibold text-text-primary">Built on Arc</p>
          <p className="text-sm text-text-secondary leading-relaxed">
            MeshPort runs on <span className="text-text-primary font-medium">Arc</span>, a blockchain from Circle — the
            company behind USDC — designed for stablecoin payments, where USDC itself pays the network fee. You hold
            and send <span className="text-text-primary font-medium">USDC</span> and <span className="text-text-primary font-medium">EURC</span>
            {' '}(digital dollars and euros) and can swap into <span className="text-text-primary font-medium">cirBTC</span>.
            Every payment settles on a public ledger, so it’s final and verifiable by anyone.
          </p>
          <p className="text-sm text-text-secondary leading-relaxed">
            Beyond everyday payments, MeshPort includes payment links, bulk payouts, merchant bills and order
            tracking, rewards for paying, and a peer-to-peer marketplace protected by on-chain escrow.
          </p>
        </div>

        <div className="bg-surface border border-warning/20 rounded-3xl p-5">
          <p className="text-sm text-warning font-semibold mb-1">Currently on Arc Testnet</p>
          <p className="text-sm text-text-secondary leading-relaxed">
            Everything works, but with test funds that have no real-world value — so you can try the whole
            experience without risk before MeshPort moves to real money.
          </p>
        </div>

        <div className="bg-surface border border-border rounded-3xl divide-y divide-border">
          {[
            { label: 'Feature Guide', path: '/feature-guide' },
            { label: 'Terms & Privacy', path: '/terms-privacy' },
            { label: 'Help & Support', path: '/help-support' },
          ].map(l => (
            <button key={l.path} onClick={() => navigate(l.path)} className="w-full flex items-center justify-between px-5 py-4 text-left active:opacity-70">
              <span className="text-sm font-medium text-text-primary">{l.label}</span>
              <ChevronRight className="w-4 h-4 text-text-secondary" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
