import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── MeshPort Feature Guide ────────────────────────────────────────────────────
// Every feature, with a real screenshot of its screen (public/guide/*.jpg,
// captured from the app with sample data) and a few plain-language steps.
// Linked from Profile → Support. Written for end users, not developers.

interface Feature {
  id: string
  title: string
  summary: string
  image: string
  steps: string[]
  /** Where "Open" takes the user (omitted when they're already past it). */
  path?: string
}
interface Section {
  heading: string
  features: Feature[]
}

const SECTIONS: Section[] = [
  {
    heading: 'Getting started',
    features: [
      {
        id: 'sign-in', title: 'Sign in', image: 'auth',
        summary: 'Open MeshPort with Google, a one-time email code, or a wallet you already have.',
        steps: [
          'Tick the box to accept the Terms and Privacy Policy.',
          'Choose Continue with Google or Continue with Email OTP — no password needed.',
          'Prefer a classic wallet? Create New Wallet gives you 12 secret words; Import Existing Wallet uses yours.',
          'Pick a .arc username and set a 6-digit passcode. That’s it.',
        ],
      },
      {
        id: 'self-custody', title: 'Your wallet is yours', image: 'security', path: '/security',
        summary: 'Every wallet is self-custodial. The key is made on your phone and never sent to MeshPort.',
        steps: [
          'With Google or email, add a passkey (Face ID, fingerprint or device PIN) when asked.',
          'Save your Recovery QR and remember its password — it brings your wallet back on a new phone.',
          'On a new device, sign in, then unlock with your passkey or scan the Recovery QR.',
          'MeshPort never stores your private key, recovery password or secret words.',
        ],
      },
    ],
  },
  {
    heading: 'Money',
    features: [
      {
        id: 'home', title: 'Home', image: 'home', path: '/',
        summary: 'Your balance, quick actions, recent people and every asset at a glance.',
        steps: [
          'The top card shows your Available Balance. Tap the eye to hide amounts.',
          'Swipe the card to see the Multichain Hub: money you can bring from other chains.',
          'Pay, Receive, Swap and More are one tap away.',
          'Tap an asset (USDC, EURC, cirBTC) to see its history.',
        ],
      },
      {
        id: 'pay', title: 'Pay', image: 'pay', path: '/pay',
        summary: 'Send money to a username, a wallet address, or someone you’ve paid before.',
        steps: [
          'Tap Pay, then pick a recent person, a contact, or search a username / 0x address.',
          'Type the amount and choose the currency.',
          'Confirm with your passcode or fingerprint. It arrives in about a second.',
        ],
      },
      {
        id: 'receive', title: 'Receive', image: 'receive', path: '/receive',
        summary: 'Your QR code, username and payment link — everything someone needs to pay you.',
        steps: [
          'Show your QR for someone to scan, or tap Share QR / Download QR.',
          'Request payment adds an amount to the QR and link.',
          'Copy your username or wallet address with one tap.',
          'Share Payment Link sends a link that opens straight to paying you.',
        ],
      },
      {
        id: 'scan', title: 'Scan to pay', image: 'scanner', path: '/scanner',
        summary: 'Pay anyone by pointing your camera at their MeshPort, wallet or shop QR.',
        steps: [
          'Tap the round scan button in the middle of the bottom bar.',
          'Point your camera at the QR — or upload a photo of one, or enter details by hand.',
          'Check who you’re paying and the amount, then confirm.',
        ],
      },
      {
        id: 'payment-links', title: 'Payment links', image: 'paylink',
        summary: 'A link like meshport.xyz/paylink/you?amount=10 that anyone can open to pay you.',
        steps: [
          'Create one from Receive (with or without an amount) and share it in any chat.',
          'The preview card shows your name and the amount, e.g. “Pay $10”.',
          'The person taps Pay — even if they don’t have MeshPort yet.',
        ],
      },
      {
        id: 'swap', title: 'Swap', image: 'swap', path: '/swap',
        summary: 'Exchange USDC, EURC and cirBTC inside the app.',
        steps: [
          'Choose what you pay and what you receive.',
          'Type an amount — the rate and what you’ll get appear before you confirm.',
          'Tap Swap. Recent swaps are listed below.',
        ],
      },
      {
        id: 'activity', title: 'Activity', image: 'activity', path: '/activity',
        summary: 'Every payment, swap and transfer, grouped by day and searchable.',
        steps: [
          'Search by username, wallet address or transaction hash.',
          'Use the filter button to show only payments, swaps, multichain moves and more.',
          'Tap any row for full details and a link to the block explorer.',
        ],
      },
      {
        id: 'insights', title: 'Insights', image: 'insights', path: '/insights',
        summary: 'A simple picture of your money: totals, top contacts and trends.',
        steps: [
          'Switch between this week, this month and this year.',
          'See what you paid, received, your net flow and who you pay most.',
          'The activity chart shows how busy each day, week or month was.',
        ],
      },
    ],
  },
  {
    heading: 'Chat',
    features: [
      {
        id: 'chat', title: 'Chat & pay', image: 'chat', path: '/chat',
        summary: 'Message friends and send money in the same conversation. Chats are end-to-end encrypted.',
        steps: [
          'Open Chats and pick a conversation, or tap the pencil to start a new one.',
          'Type a message, or tap Pay inside the chat to send money — it shows as a payment card.',
          'Send photos and files with the paperclip.',
          'Only you and the other person can read the chat — not even MeshPort.',
        ],
      },
    ],
  },
  {
    heading: 'Multichain',
    features: [
      {
        id: 'hub', title: 'Multichain Hub — Transfer', image: 'multichain', path: '/multichain',
        summary: 'Send USDC from your MeshPort balance to a wallet on another blockchain.',
        steps: [
          'The ticket shows what you can transfer (on Arc) and bring (on other chains).',
          'Pick a destination chain and route — Unified Balance or CCTP.',
          'Enter the recipient address (or Use my address) and amount, then confirm.',
          'Track every step in the Activity tab.',
        ],
      },
      {
        id: 'bring', title: 'Bring funds', image: 'bring', path: '/multichain?tab=bring',
        summary: 'Move USDC sitting on other chains into your MeshPort balance.',
        steps: [
          'Open the Bring tab — MeshPort checks about 20 chains for you.',
          'Each chain with money shows its balance.',
          'Select a chain and bring the funds to Arc in one step.',
        ],
      },
      {
        id: 'recover', title: 'Recover funds', image: 'recover', path: '/multichain?tab=recovery',
        summary: 'If a cross-chain move ever gets stuck, finish or reverse it here.',
        steps: [
          'Open the Recover tab in the Multichain Hub.',
          'Anything stuck is listed with what happened.',
          'Tap to finish it — or see “Nothing stuck” when all is well.',
        ],
      },
    ],
  },
  {
    heading: 'More tools',
    features: [
      {
        id: 'bulk', title: 'Bulk payout', image: 'bulk', path: '/bulk-payout',
        summary: 'Pay many people in a single transaction.',
        steps: [
          'Add recipients one by one, or upload a CSV of usernames and amounts.',
          'Add an optional purpose (e.g. “March salaries”).',
          'Review the total and confirm once — everyone is paid together.',
        ],
      },
      {
        id: 'rewards', title: 'Rewards', image: 'rewards', path: '/rewards',
        summary: 'Earn points when you pay, then turn them into USDC.',
        steps: [
          'Every payment earns points, up to a daily limit (see How to Earn).',
          'Once you have enough, choose how many points to claim.',
          'Tap Claim — the USDC lands in your balance.',
        ],
      },
      {
        id: 'p2p', title: 'P2P marketplace', image: 'p2p', path: '/p2p',
        summary: 'Buy and sell USDC with other people, protected by escrow.',
        steps: [
          'Browse offers in Buy USDC or Sell USDC, and filter by payment method.',
          'Open an offer to start a trade — the USDC is held in escrow.',
          'Funds are released only when both sides confirm. Create your own offer any time.',
        ],
      },
      {
        id: 'merchant', title: 'Merchant account', image: 'merchant', path: '/merchant',
        summary: 'Take payments as a business, with bills, order numbers and a ledger.',
        steps: [
          'Apply with your business name and type.',
          'Once approved, send bills and payment requests with an order number.',
          'Customers can pay from any supported chain; it lands in your Arc wallet.',
        ],
      },
      {
        id: 'treasury', title: 'Treasury', image: 'treasury', path: '/treasury',
        summary: 'A preview of staking on Arc — validators, uptime and rewards.',
        steps: [
          'See the validators and their expected yearly return.',
          'Staking goes live with Arc mainnet; this is a testnet preview.',
        ],
      },
      {
        id: 'notifications', title: 'Notifications', image: 'notifications', path: '/notifications',
        summary: 'Payments received, rewards and trade updates in one place.',
        steps: [
          'Tap the bell on Home.',
          'Allow notifications when asked to hear about payments even when the app is closed.',
        ],
      },
    ],
  },
  {
    heading: 'Account',
    features: [
      {
        id: 'profile', title: 'Profile', image: 'profile', path: '/profile',
        summary: 'Your name, photo, username and every setting.',
        steps: [
          'Edit Profile changes your photo and display name.',
          'Share sends your profile; Copy copies your wallet address.',
          'Settings, backup, appearance and help are all listed here.',
        ],
      },
      {
        id: 'security', title: 'Security', image: 'security', path: '/security',
        summary: 'Passkeys, Recovery QR, passcode and fingerprint unlock.',
        steps: [
          'Google and email accounts see their sign-in, passkeys and Recovery QR here.',
          'Turn Passcode Lock and fingerprint / face unlock on or off.',
          'Change your 6-digit passcode, or tap Lock Now.',
        ],
      },
      {
        id: 'backup', title: 'Backup', image: 'backup', path: '/backup',
        summary: 'For created or imported wallets: view your secret words or private key.',
        steps: [
          'Enter your passcode to reveal them.',
          'Write them down on paper — never screenshot or share them.',
        ],
      },
      {
        id: 'appearance', title: 'Appearance', image: 'appearance', path: '/appearance',
        summary: 'Light, dark, or follow your device.',
        steps: ['Pick System, Light or Dark — it changes instantly.'],
      },
      {
        id: 'help', title: 'Help & support', image: 'help', path: '/help-support',
        summary: 'Tell us about a problem and follow the reply.',
        steps: [
          'Choose a topic, describe what happened and tap Submit ticket.',
          'Your tickets and their answers appear below.',
        ],
      },
    ],
  },
]

export function FeatureGuidePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [zoom, setZoom] = useState<Feature | null>(null)

  const jump = (id: string) => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Feature Guide</h1>
        </div>
      </div>

      <div className="px-4 pb-10 space-y-7 lg:max-w-[900px] lg:mx-auto">
        <p className="text-sm text-text-secondary px-1">Everything MeshPort can do, with the real screens. Tap a feature to jump to it.</p>

        {/* ── All features ── */}
        <div className="bg-surface border border-border rounded-3xl p-4 space-y-4">
          {SECTIONS.map(section => (
            <div key={section.heading}>
              <p className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-2 px-1">{section.heading}</p>
              <div className="flex flex-wrap gap-2">
                {section.features.map(f => (
                  <button key={f.id} onClick={() => jump(f.id)}
                    className="px-3 h-8 rounded-full border border-border bg-bg text-[12.5px] font-medium text-text-primary active:scale-95 transition-transform">
                    {f.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* ── Each feature ── */}
        {SECTIONS.map(section => (
          <div key={section.heading} className="space-y-3">
            <p className="text-xs font-bold text-text-secondary uppercase tracking-wider px-1">{section.heading}</p>
            {section.features.map(f => (
              <div key={f.id} id={`guide-${f.id}`} className="scroll-mt-24 bg-surface border border-border rounded-3xl p-4 flex flex-col sm:flex-row gap-4">
                <button onClick={() => setZoom(f)} aria-label={`Enlarge ${f.title} screen`}
                  className="self-center sm:self-start flex-shrink-0 w-[150px] rounded-2xl overflow-hidden border border-border bg-bg shadow-elevation-1">
                  <img src={`/guide/${f.image}.jpg`} alt={`${f.title} screen`} width={390} height={780}
                    loading="lazy" decoding="async" className="block w-full h-auto" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-[15.5px] font-bold text-text-primary">{f.title}</p>
                  <p className="text-sm text-text-secondary leading-relaxed mt-1">{f.summary}</p>
                  <ol className="mt-3 space-y-2">
                    {f.steps.map((s, i) => (
                      <li key={i} className="flex gap-2.5 text-[13.5px] text-text-primary leading-relaxed">
                        <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-brand/10 text-brand text-[11px] font-bold flex items-center justify-center">{i + 1}</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                  {f.path && (
                    <button onClick={() => navigate(f.path!)}
                      className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-brand active:opacity-70">
                      Open {f.title} <ChevronRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
        <p className="text-[11.5px] text-text-muted text-center px-4">Screens show sample names and amounts.</p>
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 mp-fade-in" style={{ background: 'rgba(0,0,0,0.75)' }} onClick={() => setZoom(null)}>
          <button onClick={() => setZoom(null)} aria-label="Close"
            className="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/15 flex items-center justify-center">
            <X className="w-5 h-5 text-white" />
          </button>
          <img src={`/guide/${zoom.image}.jpg`} alt={`${zoom.title} screen`}
            className="max-h-full max-w-full rounded-3xl shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
