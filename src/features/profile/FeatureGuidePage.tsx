import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── MeshPort Feature Guide ────────────────────────────────────────────────────
// Plain-language explainer of what every part of the app does, linked from
// Profile → Support. Content intentionally avoids technical terms (CCTP,
// attestation, Multicall3, etc.) — this is written for end users, not devs.

interface GuideEntry {
  title: string
  body: string
}
interface GuideSection {
  heading: string
  entries: GuideEntry[]
}

const SECTIONS: GuideSection[] = [
  {
    heading: 'Getting started',
    entries: [
      { title: '1. Sign in with your email', body: 'No password to remember. You type your email, get a one-time code sent to it, and enter that code. That\u2019s it \u2014 you\u2019re in.' },
      { title: '2. Set up your wallet', body: 'This is where your money actually lives. Create a new wallet (you\u2019ll get 12 secret words \u2014 write these down and keep them safe), or use a wallet you already have by entering your secret words or private key.' },
      { title: '3. Pick a username', body: 'Choose a name like sunil.arc. This becomes your public identity \u2014 how people find you, pay you, and message you \u2014 like a phone number, but for money.' },
      { title: '4. Set a 6-digit PIN', body: 'Like an ATM PIN. It unlocks the app every time you open it, and you\u2019ll be asked for it again to approve every payment you send.' },
    ],
  },
  {
    heading: 'Your profile',
    entries: [
      { title: 'Edit Profile', body: 'Change your photo or display name any time.' },
      { title: 'Security', body: 'Turn your PIN lock on or off, turn on fingerprint or face unlock, or change your PIN.' },
      { title: 'Backup', body: 'Save a fresh copy of your secret recovery words or private key, in case you didn\u2019t save them properly the first time.' },
    ],
  },
  {
    heading: 'Sending & receiving money',
    entries: [
      { title: 'Pay', body: 'Pick who you\u2019re paying (by username or wallet address), type an amount, confirm with your PIN. The payment goes out right away.' },
      { title: 'Receive', body: 'Show a QR code for someone to scan, or share your payment link (like meshport.xyz/pay/sunil) \u2014 it takes them straight to paying you, even if they don\u2019t have the app yet.' },
      { title: 'Scanner', body: 'Point your camera at someone else\u2019s QR code to pay them instantly. You can also upload a photo of a QR code or type in the details by hand.' },
      { title: 'Swap', body: 'Trade one type of money for another right in the app \u2014 between USDC, EURC, and cirBTC. You see the exchange rate before confirming.' },
    ],
  },
  {
    heading: 'Extra features',
    entries: [
      { title: 'Chat', body: 'Message your friends like a normal chat app \u2014 and send them money in the same conversation, shown as its own payment card in the thread.' },
      { title: 'Insights', body: 'A simple dashboard about your own spending \u2014 who you pay most, your average payment size, your biggest payment, and how it\u2019s changed over time.' },
      { title: 'Rewards', body: 'Earn points every time you make a payment, up to a daily cap. Once you\u2019ve got enough, trade them in for real testnet money.' },
      { title: 'Bulk Payout', body: 'Pay many recipients at once, in a single batch, instead of one at a time. Add people one by one, or upload a spreadsheet of names and amounts.' },
    ],
  },
  {
    heading: 'Moving money across blockchains',
    entries: [
      { title: 'Multichain Transfer', body: 'Transfer your money across all chains \u2014 out to a wallet on a different blockchain entirely, for when you need to use it somewhere else.' },
      { title: 'Multichain Claim', body: 'Bring money sitting on other blockchains back into your MeshPort wallet in one place. The app checks around 20 different blockchains for you and shows what\u2019s waiting to be claimed.' },
    ],
  },
]

export function FeatureGuidePage() {
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
          <h1 className="text-xl font-bold text-text-primary">MeshPort Feature Guide</h1>
        </div>
      </div>

      <div className="px-4 pb-8 space-y-6">
        <p className="text-sm text-text-secondary px-1">A simple guide to what MeshPort does.</p>

        {SECTIONS.map(section => (
          <div key={section.heading}>
            <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3 px-1">{section.heading}</p>
            <div className="bg-surface border border-border rounded-3xl divide-y divide-border">
              {section.entries.map(entry => (
                <div key={entry.title} className="px-4 py-4">
                  <p className="text-sm font-semibold text-text-primary mb-1">{entry.title}</p>
                  <p className="text-sm text-text-secondary leading-relaxed">{entry.body}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
