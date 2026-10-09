import { KeyRound, Fingerprint, QrCode, ShieldOff, MessageCircle, BadgeCheck } from 'lucide-react'
import { Reveal, RevealGroup, staggerItem } from './Reveal'
import { motion } from 'framer-motion'

// How a MeshPort wallet stays yours - every sign-in method ends in the same
// place: a key made on your device that MeshPort never receives.
const POINTS = [
  { icon: KeyRound, title: 'Made on your device', desc: 'Your wallet key is generated in your browser. Create, import or sign in with Google or email - the key is never sent to MeshPort.' },
  { icon: Fingerprint, title: 'Unlock with a passkey', desc: 'Google and email accounts unlock with Face ID, fingerprint or your device PIN, on any device your passkey syncs to.' },
  { icon: QrCode, title: 'Recovery QR you keep', desc: 'A backup sealed with a password only you know. Scan it on a new phone to get your wallet back - useless to anyone without the password.' },
  { icon: ShieldOff, title: 'Nothing to hand over', desc: 'MeshPort stores no private keys, no recovery passwords and no seed phrases. It can’t move your funds, and neither can anyone who breaks into it.' },
]

const STEPS = [
  { n: '1', title: 'Sign in', desc: 'Google, an email code, or your own wallet.' },
  { n: '2', title: 'Key is created', desc: 'On this device, sealed by the browser.' },
  { n: '3', title: 'Secure it', desc: 'Add a passkey and save your Recovery QR.' },
  { n: '4', title: 'Any device', desc: 'Unlock with the passkey or scan the QR.' },
]

const CHAT = [
  { icon: MessageCircle, title: 'End-to-end encrypted', desc: 'Messages are locked on your phone and only unlocked on theirs. MeshPort relays them but can’t read them.' },
  { icon: BadgeCheck, title: 'Signed by your wallet', desc: 'Each chat key is signed by its wallet, and the app warns you if a contact’s key ever changes.' },
]

export function SelfCustody() {
  return (
    <section id="self-custody" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand-text">Self-custody</p>
        <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">
          Your keys. Your money. Your messages.
        </h2>
        <p className="mt-4 text-[15.5px] leading-relaxed text-text-secondary">
          Every MeshPort wallet is self-custodial - including the ones you open with Google or an email code. The key is made on your device, protected by your passkey and a Recovery QR only you can open, and never stored by MeshPort.
        </p>
      </Reveal>

      <RevealGroup className="mt-14 grid grid-cols-1 gap-4 sm:mt-16 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
        {POINTS.map(p => (
          <motion.div
            key={p.title}
            variants={staggerItem}
            whileHover={{ y: -3 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="flex flex-col gap-3 rounded-[20px] border border-border bg-surface p-6 shadow-elevation-1"
          >
            <p.icon size={22} className="text-brand-text" />
            <h3 className="text-[15.5px] font-bold text-text-primary">{p.title}</h3>
            <p className="text-[13px] leading-relaxed text-text-secondary">{p.desc}</p>
          </motion.div>
        ))}
      </RevealGroup>

      <Reveal className="mt-6 rounded-[24px] border border-border bg-surface p-6 shadow-elevation-1 sm:p-8">
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-text-muted">How it works</p>
        <ol className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(s => (
            <li key={s.n} className="flex items-start gap-3">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand text-[13px] font-bold text-white">{s.n}</span>
              <div>
                <p className="text-[14.5px] font-bold text-text-primary">{s.title}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </Reveal>

      <RevealGroup className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-5">
        {CHAT.map(p => (
          <motion.div
            key={p.title}
            variants={staggerItem}
            className="flex items-start gap-4 rounded-[20px] border border-border bg-surface p-6 shadow-elevation-1"
          >
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-brand/10">
              <p.icon size={21} className="text-brand-text" />
            </span>
            <div>
              <h3 className="text-[15.5px] font-bold text-text-primary">{p.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{p.desc}</p>
            </div>
          </motion.div>
        ))}
      </RevealGroup>
    </section>
  )
}
