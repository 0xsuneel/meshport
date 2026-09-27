import { KeyRound, Fingerprint, Lock } from 'lucide-react'
import { Reveal, RevealGroup, staggerItem } from './Reveal'
import { motion } from 'framer-motion'

const POINTS = [
  { icon: KeyRound, title: 'Create or import your own wallet', desc: 'Your private key is generated on your device and never sent anywhere.' },
  { icon: Fingerprint, title: 'Local authorization', desc: 'Passcode and optional biometric unlock protect every sensitive action.' },
  { icon: Lock, title: 'No MeshPort access to your funds', desc: "MeshPort can't move funds out of a self-custodial wallet on your behalf." },
]

export function SelfCustody() {
  return (
    <section id="self-custody" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand">Self-custody</p>
        <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">
          Your wallet stays yours.
        </h2>
        <p className="mt-4 text-[15.5px] leading-relaxed text-text-secondary">
          MeshPort is designed around self-custody. When you create or import a wallet, your key stays on your device and MeshPort never sees it. Signing in with Google or email instead uses a recoverable model, so sensitive wallet operations still stay protected by local authorization even without a seed phrase. Your key is encrypted at rest and only ever decrypted in memory for your own authenticated request.
        </p>
      </Reveal>

      <RevealGroup className="mt-14 grid grid-cols-1 gap-4 sm:mt-16 sm:grid-cols-3 lg:gap-5">
        {POINTS.map(p => (
          <motion.div
            key={p.title}
            variants={staggerItem}
            whileHover={{ y: -3 }}
            transition={{ type: 'spring', stiffness: 300, damping: 22 }}
            className="flex flex-col gap-3 rounded-[20px] border border-border bg-surface p-6 shadow-elevation-1"
          >
            <p.icon size={22} className="text-brand" />
            <h3 className="text-[15.5px] font-bold text-text-primary">{p.title}</h3>
            <p className="text-[13px] leading-relaxed text-text-secondary">{p.desc}</p>
          </motion.div>
        ))}
      </RevealGroup>
    </section>
  )
}
