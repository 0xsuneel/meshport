import { Reveal } from './Reveal'

// What MeshPort keeps about you and what it never collects - the landing
// page's short version of the Privacy Policy (/privacy). Kept in step with
// features/profile/TermsPrivacyPage.tsx.
const KEEPS = [
  { title: 'Your .arc username and wallet address', desc: 'So people can pay you by name. Your address is public on the blockchain anyway.' },
  { title: 'A profile photo - if you add one', desc: 'Your display name and photo are optional, and you can change or remove them any time.' },
  { title: 'Your payment history', desc: 'So Activity, receipts and payment cards in chat show on any device. The same payments are on the public blockchain.' },
]

const NEVER = [
  'Email, phone number or real name',
  'ID documents or selfies',
  'Your location or phone contacts',
  'Private keys, secret words or passcode',
  'Your face or fingerprint',
  'What you say in chats',
  'Ad or analytics trackers',
]

const CHAT_STEPS = [
  { title: 'A new key for every message', desc: 'Each message, photo and file is locked on your phone with its own 256-bit AES-GCM key.' },
  { title: 'Only your two phones can open it', desc: 'That key is sealed with a secret (X25519) only you and the person you’re chatting with can work out. MeshPort relays the locked message - it has no key to open it.' },
  { title: 'Keys signed by wallets', desc: 'Every chat key is signed by its wallet, and the app warns you if a contact’s key ever changes - so no one can slip in their own.' },
  { title: 'Gone once delivered', desc: 'A message leaves our servers as soon as it reaches the other phone (or after 30 days undelivered). Chats live on your phone, with no backup.' },
]

export function PrivacySection() {
  return (
    <section id="privacy" className="scroll-mt-24">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <Reveal>
          <h2 className="max-w-3xl text-[30px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[40px]">
            Private by design. We don’t collect your data.
          </h2>
          <p className="mt-5 max-w-2xl text-[18px] leading-relaxed text-text-secondary">
            MeshPort only keeps what a payments app needs to work - nothing that says who you are.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <Reveal delay={0.04}>
            <div className="h-full rounded-3xl bg-surface p-6 sm:p-8 soft-card">
              <p className="text-[13px] font-bold uppercase tracking-wider text-brand-text">All we keep</p>
              <dl className="mt-5 space-y-5">
                {KEEPS.map(k => (
                  <div key={k.title}>
                    <dt className="text-[17px] font-bold text-text-primary">{k.title}</dt>
                    <dd className="mt-1 text-[15.5px] leading-relaxed text-text-secondary">{k.desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="h-full rounded-3xl bg-surface p-6 sm:p-8 soft-card">
              <p className="text-[13px] font-bold uppercase tracking-wider text-brand-text">Never collected</p>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                {NEVER.map(n => (
                  <li key={n} className="flex items-start gap-2.5 text-[15.5px] leading-snug text-text-primary">
                    <span aria-hidden className="mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-danger/10 text-[11px] font-bold text-danger">✕</span>
                    {n}
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-[14px] leading-relaxed text-text-secondary">
                We don’t sell or share data with advertisers. Business, P2P and support details are kept only if you use those features.{' '}
                <a href="/privacy" className="font-semibold text-brand-text underline-offset-2 hover:underline">Read the Privacy Policy</a>
              </p>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.06}>
          <h3 className="mt-16 text-[24px] font-extrabold tracking-tight text-text-primary sm:text-[28px]">How your messages are encrypted</h3>
          <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {CHAT_STEPS.map((s, i) => (
              <li key={s.title} className="rounded-3xl border border-border p-6">
                <span className="flex size-8 items-center justify-center rounded-full bg-brand text-[14px] font-bold text-white">{i + 1}</span>
                <p className="mt-4 text-[17px] font-bold text-text-primary">{s.title}</p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-text-secondary">{s.desc}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  )
}
