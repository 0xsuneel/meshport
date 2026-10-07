import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── Terms & Privacy ──────────────────────────────────────────────────────────
// Linked from Profile → Support → Terms & Privacy. Draft legal content
// grounded in what the app actually does (every wallet self-custodial — keys
// made on the device, passkey / Recovery QR for Google & email accounts,
// end-to-end encrypted chat, testnet only). NOT reviewed by a lawyer —
// flagged in-page and should be reviewed by one before any real-money launch.
//
// Reachable at three URLs — /terms and /privacy each land directly on their
// own document (needed for Google OAuth consent screen verification, which
// wants a distinct direct link to each, not a single combined page with
// tabs), and /legal keeps working as a general entry point defaulting to
// Terms. All three render the same component; only which tab is selected
// on load differs, driven by the URL rather than always starting on
// 'terms' regardless of which link was actually followed.

type Tab = 'terms' | 'privacy'

export function TermsPrivacyPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState<Tab>(location.pathname === '/privacy' ? 'privacy' : 'terms')

  const selectTab = (t: Tab) => {
    setTab(t)
    // BUG FIX (2026-09-03): this used to unconditionally navigate to the
    // bare /terms or /privacy route on every tab switch — correct for the
    // public, pre-login /terms /privacy /legal paths (wrapped in
    // AuthShell, deliberately phone-width with no sidebar — see that
    // file's own comment; needed for Google OAuth consent screen
    // verification, which wants each document at its own distinct URL),
    // but wrong when this page was reached via Profile → Support's
    // in-app /terms-privacy route (nested inside AppLayout, with the
    // desktop sidebar). Tapping a tab there bounced the user OUT of the
    // correct AppLayout-wrapped route into the bare public one — losing
    // the sidebar and getting force-capped to phone width even on a full
    // desktop viewport, which is exactly what this looked like: clicking
    // the page's own tabs somehow "opened mobile layout and hid the
    // sidebar." Only switch to the public /terms or /privacy URL when
    // already ON one of the public paths (so that direct-link/OAuth deep
    // linking still works); for the in-app route, just update the local
    // tab state and stay there.
    const onPublicLegalPath = ['/terms', '/privacy', '/legal'].includes(location.pathname)
    if (onPublicLegalPath) {
      navigate(t === 'privacy' ? '/privacy' : '/terms', { replace: true })
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Terms & Privacy</h1>
        </div>
      </div>

      <div className="px-5 pt-2">
        <div className="flex gap-2 mb-5 bg-surface border border-border rounded-2xl p-1">
          <button onClick={() => selectTab('terms')}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${tab === 'terms' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
            Terms of Service
          </button>
          <button onClick={() => selectTab('privacy')}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${tab === 'privacy' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
            Privacy Policy
          </button>
        </div>
      </div>

      <div className="px-5 pb-8 space-y-5">
        <div className="bg-surface border border-warning/20 rounded-2xl p-4">
          <p className="text-xs text-warning font-semibold mb-1">Draft — not yet legally reviewed</p>
          <p className="text-xs text-text-secondary leading-relaxed">
            This is placeholder legal content, written to reflect how MeshPort currently works. It has not
            been reviewed by a lawyer and should not be treated as a finished legal document, especially
            before any launch involving real funds.
          </p>
        </div>

        {tab === 'terms' ? <TermsContent /> : <PrivacyContent />}

        <p className="text-xs text-text-secondary text-center pt-2">Last updated: 4 October 2026 (draft)</p>
      </div>
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-3xl p-5">
      <p className="text-sm font-semibold text-text-primary mb-2">{title}</p>
      <div className="text-sm text-text-secondary leading-relaxed space-y-2">{children}</div>
    </div>
  )
}

function TermsContent() {
  return (
    <div className="space-y-4">
      <Block title="1. Accepting these terms">
        <p>By creating an account or using MeshPort, you agree to these Terms and to the Privacy Policy. If you don’t agree, please don’t use the app.</p>
      </Block>

      <Block title="2. What MeshPort is today">
        <p>MeshPort is a self-custodial payments app built on Arc, a blockchain from Circle. It currently runs on <span className="text-text-primary">Arc Testnet</span>: every balance, payment, swap and reward in the app uses test tokens with no real monetary value, which can’t be exchanged for real money.</p>
      </Block>

      <Block title="3. Who can use MeshPort">
        <p>You must be old enough to form a binding contract where you live. If you use MeshPort for a business or organization, you confirm you’re allowed to accept these Terms on its behalf.</p>
      </Block>

      <Block title="4. Your wallet is yours">
        <p>Every MeshPort wallet is <span className="text-text-primary">self-custodial</span>. Whether you create a wallet, import one, or sign in with Google or an email code, the wallet’s private key is generated or kept on your own device. MeshPort never receives it and never stores it — not in plain form, not encrypted. MeshPort cannot move, freeze, recover or reverse funds in your wallet.</p>
        <p><span className="text-text-primary">Google / email accounts.</span> Signing in proves who you are, but doesn’t open the wallet. On a new device you open it with a <span className="text-text-primary">passkey</span> (Face ID, fingerprint or device PIN) or your <span className="text-text-primary">Recovery QR</span> and its password. Keep at least one of them safe. If you lose access to both, the wallet cannot be recovered — by you or by MeshPort.</p>
        <p><span className="text-text-primary">Created or imported wallets.</span> Your 12 secret words or private key are the only way to restore the wallet. Store them offline and never share them. MeshPort has no copy.</p>
        <p>You’re responsible for your passcode, passkeys, Recovery QR and its password, secret words, and the devices you use MeshPort on.</p>
      </Block>

      <Block title="5. Payments are final">
        <p>Blockchain transactions can’t be cancelled or reversed once confirmed. Check the recipient and amount before you confirm — MeshPort can’t undo a payment sent to the wrong person or address.</p>
        <p>Cross-chain transfers depend on third-party infrastructure (Circle’s Gateway and CCTP) and can take longer than payments on Arc. If one gets stuck, the Recover tab helps you finish it, but timing isn’t guaranteed.</p>
      </Block>

      <Block title="6. Rewards, P2P and merchants">
        <p><span className="text-text-primary">Rewards</span> points have no cash value outside the app. Earning rules, limits and claim amounts may change or end at any time, and claims depend on the rewards treasury having funds.</p>
        <p><span className="text-text-primary">P2P marketplace</span> trades are between users. Escrow holds the crypto side of a trade until it completes, but MeshPort isn’t a party to the trade and doesn’t process fiat payments. On testnet, currencies and payment methods are for demonstration only.</p>
        <p><span className="text-text-primary">Merchant accounts</span> are approved at MeshPort’s discretion. Merchants are responsible for what they sell and for their dealings with customers.</p>
      </Block>

      <Block title="7. Acceptable use">
        <p>Don’t use MeshPort to break the law; to send funds obtained by fraud or theft; to launder money or finance illegal activity; to harass, impersonate or deceive others; to access other people’s accounts or our systems without permission; or to disrupt the app or its infrastructure. We may limit or close accounts that do.</p>
      </Block>

      <Block title="8. No warranty">
        <p>MeshPort is provided “as is,” especially while on testnet. We don’t promise it will always be available, error-free or secure, and we aren’t responsible for losses caused by network outages, blockchain or smart-contract issues, third-party services, or lost credentials.</p>
      </Block>

      <Block title="9. Limitation of liability">
        <p>To the fullest extent the law allows, MeshPort and its team aren’t liable for indirect, incidental or consequential damages from using the app, including loss of funds, data or access to a wallet.</p>
      </Block>

      <Block title="10. Changes">
        <p>We may update these Terms as MeshPort evolves — in particular before any move from testnet to real funds. The date at the bottom shows the latest version. Continuing to use MeshPort after a change means you accept it.</p>
      </Block>

      <Block title="11. Contact">
        <p>Questions about these Terms can be sent through Help & Support in the app.</p>
      </Block>
    </div>
  )
}

function PrivacyContent() {
  return (
    <div className="space-y-4">
      <Block title="1. The short version">
        <p>MeshPort never has your wallet key, can’t read your chats, and doesn’t sell your data. We keep what’s needed to run your account — your profile, your public wallet address and your app activity.</p>
      </Block>

      <Block title="2. What we collect">
        <p><span className="text-text-primary">Account</span> — your email address (from Google or the email code you sign in with), username, display name and profile photo if you add one.</p>
        <p><span className="text-text-primary">Wallet</span> — your public wallet address. For Google and email accounts we also store your passkeys’ public details (credential id, the device name it was added on, the date) and your wallet key <em>encrypted by your passkey</em>, which only your passkey can unlock. For the Recovery QR we store only the date you made it.</p>
        <p><span className="text-text-primary">Activity</span> — payments, swaps, multichain transfers, claims, bulk payouts, rewards, P2P trades and merchant bills you make in the app, to show your history, Insights and notifications. Most of this is also public on the blockchain.</p>
        <p><span className="text-text-primary">Chats</span> — messages, photos and files are end-to-end encrypted, so we store and relay them only as ciphertext. We can see who you chat with and when, and the details of payment cards (amount, token, transaction), which are public on the blockchain anyway. Your chat key’s public half and your wallet’s signature over it are stored so others can verify it’s really you.</p>
        <p><span className="text-text-primary">Merchants and support</span> — what you enter when you apply for a merchant account (business name, type, optional contact) and the tickets you send to Help & Support.</p>
        <p><span className="text-text-primary">Device and usage</span> — notification subscriptions if you allow push notifications, and basic technical logs (errors, feature usage) to keep the app working.</p>
      </Block>

      <Block title="3. What we never collect">
        <p>Your private key or secret words — for any kind of wallet. Your Recovery QR’s contents or its password. The secret your passkey produces. Your passcode (only a scrambled check of it stays on your device). The contents of your chats.</p>
        <p>On your device, MeshPort keeps a copy of your wallet key sealed with a key that never leaves your browser, so reopening the app is instant. Logging out removes it.</p>
      </Block>

      <Block title="4. How we use your data">
        <p>To run your account and wallet, deliver payments and messages, show your history and Insights, send notifications you’ve turned on, verify cross-chain transfers, answer support requests, prevent fraud and abuse, and improve the app.</p>
      </Block>

      <Block title="5. Who we share it with">
        <p><span className="text-text-primary">Supabase</span> — our database and sign-in provider. It stores your account data, activity and encrypted messages.</p>
        <p><span className="text-text-primary">Vercel</span> — hosts the app and builds payment-link previews (name, photo and amount of a link you share).</p>
        <p><span className="text-text-primary">Google</span> — if you choose “Continue with Google,” it confirms your email to us.</p>
        <p><span className="text-text-primary">Circle and blockchain networks</span> — Arc, Circle’s Gateway and CCTP, and public blockchain nodes process your transactions. Nodes can see the requests your device sends, like any blockchain app.</p>
        <p>We don’t sell your personal data or share it with advertisers. We may disclose information if the law requires it.</p>
      </Block>

      <Block title="6. Blockchain data is public">
        <p>Wallet addresses, amounts and transaction times on Arc and other blockchains are visible to anyone, permanently. Linking your username to your address in MeshPort means people you pay can connect the two.</p>
      </Block>

      <Block title="7. Keeping and deleting data">
        <p>We keep your account data while your account is active and as long as needed for legal obligations or disputes afterwards. You can ask to delete your account through Help & Support. Records already on the blockchain can’t be deleted by anyone.</p>
      </Block>

      <Block title="8. Your choices">
        <p>Edit your name and photo in Edit Profile, manage passkeys and your Recovery QR in Security, turn notifications on or off in your device settings, and contact us to access or delete your data.</p>
      </Block>

      <Block title="9. Children">
        <p>MeshPort isn’t meant for children, and we don’t knowingly collect data from anyone under the age of digital consent where they live.</p>
      </Block>

      <Block title="10. Changes">
        <p>We’ll update this policy as MeshPort changes and show the new date at the bottom.</p>
      </Block>

      <Block title="11. Contact">
        <p>Privacy questions can be sent through Help & Support in the app.</p>
      </Block>
    </div>
  )
}
