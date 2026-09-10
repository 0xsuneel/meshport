import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── About MeshPort ─────────────────────────────────────────────────────────────
// Linked from Profile → Support → About MeshPort. Product description, not a
// feature list (see FeatureGuidePage.tsx for that) — this is the "what is
// this app and why does it exist" page.

export function AboutPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">About MeshPort</h1>
        </div>
      </div>

      <div className="px-5 pb-8 pt-2 space-y-5">
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <img src="/favicon.svg" alt="MeshPort" className="w-16 h-16 rounded-2xl" />
          <div>
            <h2 className="text-xl font-bold text-text-primary">MeshPort</h2>
            <p className="text-sm text-text-secondary mt-1">USDC Payments, Made Simple</p>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-3xl p-5 space-y-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            MeshPort is a payments app built for sending stablecoins as easily as sending a text —
            no wallet addresses to copy-paste, no gas token juggling, no separate crypto exchange required.
          </p>
          <p className="text-sm text-text-secondary leading-relaxed">
            Every MeshPort account gets a simple <span className="text-text-primary font-medium">.arc</span> username
            instead of a 42-character wallet address. Paying someone is as easy as knowing their name — send it
            in a tap, share a QR code, or drop a payment link that works even if the other person doesn't have
            the app yet.
          </p>
          <p className="text-sm text-text-secondary leading-relaxed">
            It's built on <span className="text-text-primary font-medium">Arc</span>, a stablecoin-focused blockchain
            network from Circle (the company behind USDC), and uses{' '}
            <span className="text-text-primary font-medium">USDC, EURC, and cirBTC</span> as its core currencies — real
            dollar- and euro-backed digital money, not speculative tokens. Because it's built on Circle's
            infrastructure, MeshPort can also reach into ~20 other blockchains — so money that ended up scattered
            across different networks can be pulled back into one place, and money can be sent out to whichever
            chain someone actually needs it on.
          </p>
          <p className="text-sm text-text-secondary leading-relaxed">
            Payments and messaging live in the same place — chatting with a friend and paying them doesn't mean
            switching apps. And because everything settles on a public blockchain, every transaction is
            verifiable and instant, without waiting on a bank's business hours.
          </p>
        </div>

        <div className="bg-surface border border-warning/20 rounded-3xl p-5">
          <p className="text-sm text-warning font-semibold mb-1">Currently on testnet</p>
          <p className="text-sm text-text-secondary leading-relaxed">
            MeshPort is running on testnet — a fully working preview of the real thing, using test funds, so
            anyone can try the whole experience risk-free before it goes live with real money.
          </p>
        </div>
      </div>
    </div>
  )
}
