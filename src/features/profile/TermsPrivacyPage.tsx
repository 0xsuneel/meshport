import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── Terms & Privacy ──────────────────────────────────────────────────────────
// Linked from Profile → Support → Terms & Privacy. Draft legal content
// grounded in what the app actually does (self-custodial wallet with an
// encrypted cloud backup, testnet-only currently, Supabase + Circle as
// third-party processors). NOT reviewed by a lawyer — flagged in-page and
// should be replaced/reviewed by one before any real-money launch.
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
            className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'terms' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
            Terms of Service
          </button>
          <button onClick={() => selectTab('privacy')}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'privacy' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
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

        <p className="text-xs text-text-secondary text-center pt-2">Last updated: draft version</p>
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
      <Block title="1. Acceptance of these terms">
        <p>By creating an account or using MeshPort, you agree to these Terms. If you don't agree to them, don't use the app.</p>
      </Block>

      <Block title="2. What MeshPort currently is">
        <p>MeshPort is currently running on <span className="text-text-primary">testnet</span> — a preview environment using test funds only, with no real monetary value. Nothing sent or received in the app today represents real money, and testnet balances cannot be exchanged for real currency.</p>
      </Block>

      <Block title="3. Eligibility">
        <p>You must be able to form a legally binding contract to use MeshPort. If you're using it on behalf of an organization, you're confirming you have authority to bind that organization to these Terms.</p>
      </Block>

      <Block title="4. Your wallet and self-custody">
        <p>MeshPort supports two different wallet models, and they carry different custody guarantees. Read the one that matches how you created your account.</p>
        <p><span className="text-text-primary">Created or imported wallets</span> (you generated a new wallet in the app, or entered your own recovery phrase / private key) are fully self-custodial. Your private key and recovery phrase are never sent to or stored by MeshPort's servers, in any form — not encrypted, not otherwise. They exist only on your own device and with you. MeshPort cannot access, recover, freeze, or reverse transactions from these wallets on your behalf, because we genuinely never have the key or recovery phrase to act on in the first place. You are solely responsible for your PIN, your recovery phrase, and your private key — losing your device without a saved copy of either means permanently losing access to the wallet. There is no "forgot password" recovery and no MeshPort-side backup to fall back on.</p>
        <p><span className="text-text-primary">Google or Email sign-in wallets</span> use a different, recoverable model so you can use MeshPort without ever handling a seed phrase. Your private key is generated on MeshPort's servers at wallet creation and stored there, encrypted at rest (a unique encryption key per wallet, itself encrypted under a separate server-held key). It is decrypted only in memory, only in direct response to a request authenticated by your live Google/Email session, and is never written back to disk or any long-term cache in plaintext. This means MeshPort's server infrastructure — not any individual person casually, but the system itself, under its own security controls — has the technical capability to decrypt this key, which is a materially different guarantee than the fully self-custodial model above. Losing your device is not a loss event for this wallet type — you recover access by signing back in with the same Google account or email. Losing access to that Google account or email address, however, does mean losing access to the wallet, the same way losing access to any account tied to that identity provider would.</p>
        <p>You can tell which model applies to your wallet from your Profile screen: if you see "Backup Seed Phrase" and/or "Backup Private Key" options, your wallet is the self-custodial type described above. If neither appears, you signed in with Google or Email and your wallet uses the recoverable model also described above.</p>
      </Block>

      <Block title="5. Acceptable use">
        <p>You agree not to use MeshPort to: violate any applicable law; send funds obtained through fraud or theft; attempt to gain unauthorized access to other users' accounts or MeshPort's systems; interfere with or disrupt the app's infrastructure; or use the app to launder money or finance illegal activity.</p>
      </Block>

      <Block title="6. Transactions are irreversible">
        <p>Blockchain transactions cannot be reversed or cancelled once confirmed. Double-check recipient usernames/addresses and amounts before confirming any payment — MeshPort cannot undo a transaction sent to the wrong recipient.</p>
      </Block>

      <Block title="7. No warranty">
        <p>MeshPort is provided "as is," especially given its current testnet status. We don't guarantee the app will be uninterrupted, error-free, or secure at all times, and we're not responsible for losses caused by network outages, smart contract bugs, third-party service failures (including Circle's infrastructure), or your own loss of credentials.</p>
      </Block>

      <Block title="8. Limitation of liability">
        <p>To the fullest extent permitted by law, MeshPort and its team aren't liable for indirect, incidental, or consequential damages arising from your use of the app, including loss of funds, data, or access to your wallet.</p>
      </Block>

      <Block title="9. Changes to these terms">
        <p>We may update these Terms as the app evolves, particularly around any future transition from testnet to real funds. Continued use of MeshPort after changes take effect means you accept the updated Terms.</p>
      </Block>

      <Block title="10. Contact">
        <p>Questions about these Terms can be sent through the Help & Support section of the app.</p>
      </Block>
    </div>
  )
}

function PrivacyContent() {
  return (
    <div className="space-y-4">
      <Block title="1. What we collect">
        <p><span className="text-text-primary">Account info</span> — your email address, chosen username, display name, and profile photo, if you set one.</p>
        <p><span className="text-text-primary">Wallet info</span> — your public wallet address, for every account. For created or imported wallets, that's all we ever have — we do not collect, receive, or store your private key or recovery phrase in any form, and they never leave your device. For Google or Email sign-in wallets, we also store your private key server-side, encrypted at rest, so you can recover the wallet by signing in again instead of needing a seed phrase — see "What we don't collect" below for exactly what that does and doesn't cover.</p>
        <p><span className="text-text-primary">Transaction data</span> — sends, receives, swaps, bridges, claims, and bulk payouts you make through the app. Much of this is also publicly visible on the blockchain itself, independent of MeshPort.</p>
        <p><span className="text-text-primary">Messages</span> — chat messages, and any files, images, or documents you send through the Chat feature, are end-to-end encrypted. Each device generates its own encryption key pair, and only the two people in a conversation can derive the key that decrypts it — MeshPort's servers store and relay only encrypted data, and cannot read message, file, image, or document content. The one thing we do see is the transaction details on a payment card sent in chat (amount, recipient, token, transaction hash) — not because chat is exempt from encryption, but because that same data is already public on the blockchain and is what powers your Activity history and transaction receipts. If you or the person you're messaging haven't yet updated to a version of the app with this feature, messages in that conversation are sent unencrypted until both of you have — the same way chat worked before this feature existed.</p>
        <p><span className="text-text-primary">Usage data</span> — basic app activity (e.g. feature usage, error logs) used to keep the app working and improve it.</p>
      </Block>

      <Block title="2. What we don't collect — and the one exception">
        <p>For wallets you created or imported yourself, we never see or store your private key or recovery phrase, in any form — not encrypted, not otherwise. We never see or store your PIN either, for any account type. All of these stay only on your device and with you. If you lose your device without a saved copy of your recovery phrase or private key, we have no backup to offer — there is genuinely nothing on our servers that can restore that wallet.</p>
        <p>The one exception: if you signed in with Google or Email, your private key was generated on our servers and is stored there, encrypted at rest, specifically so you can recover the wallet by signing in again rather than needing a seed phrase. It's decrypted only in memory, only for a request authenticated by your live session, and only for as long as that one request takes. We designed it this way deliberately so you never have to see, write down, or lose a seed phrase to use MeshPort — but it does mean this key isn't purely self-custodial the way a created/imported wallet's is. Protecting it comes down to keeping your Google account or email address secure, the same as any other account tied to that identity provider.</p>
      </Block>

      <Block title="3. How we use your data">
        <p>To operate your account and wallet, process transactions, show your transaction history and Insights, enable Chat, send you notifications about incoming payments, and maintain the security of the app.</p>
      </Block>

      <Block title="4. Who we share it with">
        <p><span className="text-text-primary">Supabase</span> — our backend and database provider, hosting your account data, encrypted wallet backup, and your end-to-end encrypted messages (stored as ciphertext Supabase cannot read).</p>
        <p><span className="text-text-primary">Circle</span> — the network MeshPort is built on (Arc) and the provider of cross-chain transfer infrastructure used by Multichain Transfer and Claim.</p>
        <p>We don't sell your personal data to advertisers or third parties.</p>
      </Block>

      <Block title="5. Blockchain data is public">
        <p>Wallet addresses and transaction amounts on Arc and other blockchains are publicly visible to anyone by design — that's how blockchains work. This is separate from the private account data (like your email) that MeshPort itself controls.</p>
      </Block>

      <Block title="6. Data retention">
        <p>We keep your account and transaction data for as long as your account is active, and as needed to comply with legal obligations or resolve disputes after that.</p>
      </Block>

      <Block title="7. Your choices">
        <p>You can update your display name and photo any time in Edit Profile. You can request account deletion through Help & Support — note that some transaction history may remain visible on the public blockchain independent of any deletion request made to MeshPort.</p>
      </Block>

      <Block title="8. Children's privacy">
        <p>MeshPort isn't intended for use by children, and we don't knowingly collect data from anyone under the applicable age of digital consent in their region.</p>
      </Block>

      <Block title="9. Changes to this policy">
        <p>We may update this Privacy Policy as the app evolves. Material changes will be reflected here with an updated date.</p>
      </Block>

      <Block title="10. Contact">
        <p>Questions about this Privacy Policy can be sent through the Help & Support section of the app.</p>
      </Block>
    </div>
  )
}
