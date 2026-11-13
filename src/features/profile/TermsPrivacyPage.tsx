import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ── Terms & Privacy ──────────────────────────────────────────────────────────
// Linked from Profile → Support → Terms & Privacy. Draft legal content
// grounded in what the app actually does (every wallet self-custodial - keys
// made on the device and locked by the passcode,
// end-to-end encrypted chat, testnet only). NOT reviewed by a lawyer -
// flagged in-page and should be reviewed by one before any real-money launch.
//
// Reachable at three URLs - /terms and /privacy each land directly on their
// own document (a distinct direct link to each, not a single combined
// page with tabs), and /legal keeps working as a general entry point defaulting to
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
    // bare /terms or /privacy route on every tab switch - correct for the
    // public, pre-login /terms /privacy /legal paths (wrapped in
    // AuthShell, deliberately phone-width with no sidebar - see that
    // file's own comment; each document at its own distinct URL),
    // but wrong when this page was reached via Profile → Support's
    // in-app /terms-privacy route (nested inside AppLayout, with the
    // desktop sidebar). Tapping a tab there bounced the user OUT of the
    // correct AppLayout-wrapped route into the bare public one - losing
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
      <div className="header-row mp-glass-header sticky top-0 z-20 justify-between px-5 pt-header pb-header">
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
          <p className="text-xs text-warning font-semibold mb-1">Draft - not yet legally reviewed</p>
          <p className="text-xs text-text-secondary leading-relaxed">
            This is placeholder legal content, written to reflect how MeshPort currently works. It has not
            been reviewed by a lawyer and should not be treated as a finished legal document, especially
            before any launch involving real funds.
          </p>
        </div>

        {tab === 'terms' ? <TermsContent /> : <PrivacyContent />}

        <p className="text-xs text-text-secondary text-center pt-2">Last updated: 14 November 2026 (draft)</p>
      </div>
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface soft-card rounded-3xl p-5">
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
        <p>Every MeshPort wallet is <span className="text-text-primary">self-custodial</span>. You create a wallet in the app or import your own; either way the wallet’s private key is generated or kept on your own device. MeshPort never receives it and never stores it - not in plain form, not encrypted. MeshPort cannot move, freeze, recover or reverse funds in your wallet.</p>
        <p>Your 12 secret words or private key are the only way to restore the wallet. Store them offline and never share them. MeshPort has no copy.</p>
        <p>You’re responsible for your passcode, your secret words or private key, and the devices you use MeshPort on.</p>
      </Block>

      <Block title="5. Payments are final">
        <p>Blockchain transactions can’t be cancelled or reversed once confirmed. Check the recipient and amount before you confirm - MeshPort can’t undo a payment sent to the wrong person or address.</p>
        <p>Cross-chain transfers depend on third-party infrastructure (Circle’s Gateway and CCTP) and can take longer than payments on Arc. If one gets stuck, the Recover tab helps you finish it, but timing isn’t guaranteed.</p>
      </Block>

      <Block title="6. Rewards, P2P and business accounts">
        <p><span className="text-text-primary">Rewards</span> points have no cash value outside the app. Earning rules, limits and claim amounts may change or end at any time, and claims depend on the rewards treasury having funds.</p>
        <p><span className="text-text-primary">P2P marketplace</span> trades are between users. Escrow holds the crypto side of a trade until it completes, but MeshPort isn’t a party to the trade and doesn’t process fiat payments. On testnet, currencies and payment methods are for demonstration only.</p>
        <p><span className="text-text-primary">Business accounts</span> are approved at MeshPort’s discretion. Businesses are responsible for what they sell and for their dealings with customers.</p>
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
        <p>We may update these Terms as MeshPort evolves - in particular before any move from testnet to real funds. The date at the bottom shows the latest version. Continuing to use MeshPort after a change means you accept it.</p>
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
        <p>MeshPort doesn’t collect personal data. No email, no phone number, no real name, no ID documents, no location, no contacts from your phone - and no trackers or ads.</p>
        <p>What we keep is what a payments app needs to work: your <span className="text-text-primary">.arc username</span> and <span className="text-text-primary">public wallet address</span>, a <span className="text-text-primary">profile photo</span> and display name only if you add them, and your <span className="text-text-primary">payment history</span>. Your wallet key and your chats never reach us in a form we can use.</p>
      </Block>

      <Block title="2. What we keep">
        <p><span className="text-text-primary">Your profile</span> - your .arc username, your public wallet address, and a display name and profile photo if you choose to add them. Others see these when they pay or chat with you.</p>
        <p><span className="text-text-primary">Your payment history</span> - payments, requests, bills, swaps, cross-chain transfers, claims, rewards and P2P trades you make in MeshPort, so the app can show your Activity, Insights and receipts and send the notifications you turn on. The same payments are public on the blockchain anyway.</p>
        <p><span className="text-text-primary">Payment cards in chat</span> - when you pay someone you chat with, the card (amount, token, transaction) is kept so it shows on both phones. It’s the same information that’s public on the blockchain.</p>
        <p><span className="text-text-primary">Your chat key’s public half</span> - with your wallet’s signature over it, so others can check a message really comes from you (see section 4).</p>
      </Block>

      <Block title="3. Only if you use these features">
        <p><span className="text-text-primary">Business account</span> - the business name and type you apply with, an optional contact, your stores (and a tax number if you add one), saved items and the bills and payments of your business.</p>
        <p><span className="text-text-primary">P2P trading and Cash out</span> - the payout method you add (for example a UPI ID or bank account), shown only to the person you’re trading with so they can pay you.</p>
        <p><span className="text-text-primary">Help & Support</span> - what you write in a support ticket.</p>
        <p><span className="text-text-primary">Notifications</span> - your device’s push subscription, if you allow notifications.</p>
        <p><span className="text-text-primary">Error reports</span> - when something breaks, the error, the screen and your browser type, so we can fix it. No location, no IP address and no message content.</p>
      </Block>

      <Block title="4. How your messages are encrypted">
        <p>Messages, photos and files are <span className="text-text-primary">end-to-end encrypted</span> on your phone before they’re sent. Each one gets its own new 256-bit key and is locked with AES-256-GCM; that key is then locked for just the two of you with a shared secret (X25519) that only your two phones can work out. MeshPort relays the locked message but has no key to open it.</p>
        <p>Your chat key comes from your wallet and is signed by it. The app only uses a contact’s key if their wallet’s signature checks out, and it warns you if a contact’s key ever changes - so nobody, including MeshPort, can quietly swap in their own key.</p>
        <p>A message is deleted from our servers as soon as the other person’s phone has it, or after 30 days if it’s never delivered. Chats are not backed up: they live on your phone, so a new device or a reinstall starts without old messages (payment cards still show).</p>
        <p>What we can see: who you chat with and when - not what you say.</p>
      </Block>

      <Block title="5. What we never collect">
        <p>Your <span className="text-text-primary">private key or 12 secret words</span> - your wallet key is made on your device and never sent to us, in any form.</p>
        <p>Your <span className="text-text-primary">passcode</span> - only a scrambled check of it stays on your device.</p>
        <p>Your <span className="text-text-primary">face or fingerprint</span> - Face ID / fingerprint unlock is handled by your phone; MeshPort only gets a yes from it, never your biometrics.</p>
        <p>The <span className="text-text-primary">contents of your chats</span>, photos and files.</p>
        <p>Your <span className="text-text-primary">email, phone number, real name, ID documents, location or phone contacts</span> - MeshPort never asks for them.</p>
        <p>There are no advertising or analytics trackers in MeshPort, and we don’t sell or rent data to anyone.</p>
      </Block>

      <Block title="6. Who else handles data">
        <p><span className="text-text-primary">Supabase</span> - our database. It stores the profile, payment history and locked messages described above.</p>
        <p><span className="text-text-primary">Vercel</span> - hosts the app and builds payment-link previews (the name, photo and amount on a link you share).</p>
        <p><span className="text-text-primary">Circle and blockchain networks</span> - Arc, Circle’s Gateway and CCTP, and public blockchain nodes process your transactions. Like for any blockchain app, nodes see the requests your device sends.</p>
        <p>Our hosting providers keep short-lived technical logs (such as IP addresses) to deliver the service; we don’t copy them into our database. We may disclose information if the law requires it.</p>
      </Block>

      <Block title="7. Blockchain data is public">
        <p>Wallet addresses, amounts and transaction times on Arc and other blockchains are visible to anyone, permanently. Because your .arc username points to your address, people you pay can connect the two.</p>
      </Block>

      <Block title="8. Keeping and deleting data">
        <p>We keep your profile and payment history while your account is active and as long as needed afterwards for legal obligations or disputes. You can ask to delete your account through Help & Support. Records already on the blockchain can’t be deleted by anyone.</p>
      </Block>

      <Block title="9. Your choices">
        <p>Add, change or remove your display name and photo in Edit Profile; manage your passcode and Face ID / fingerprint unlock in Security; turn notifications on or off in your device settings; and contact us to see or delete your data.</p>
      </Block>

      <Block title="10. Children">
        <p>MeshPort isn’t meant for children, and we don’t knowingly hold data about anyone under the age of digital consent where they live.</p>
      </Block>

      <Block title="11. Changes">
        <p>We’ll update this policy as MeshPort changes and show the new date at the bottom.</p>
      </Block>

      <Block title="12. Contact">
        <p>Privacy questions can be sent through Help & Support in the app.</p>
      </Block>
    </div>
  )
}
