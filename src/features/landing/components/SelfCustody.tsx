import { Reveal } from './Reveal'

// How a MeshPort wallet stays yours - every sign-in method ends in the same
// place: a key made on your device that MeshPort never receives.
const POINTS = [
  { title: 'Made on your device', desc: 'Your wallet key is generated in your browser. Create, import or sign in with Google or email - the key is never sent to MeshPort.' },
  { title: 'Unlock with a passkey', desc: 'Google and email accounts unlock with Face ID, fingerprint or your device PIN, on any device your passkey syncs to.' },
  { title: 'Recovery QR you keep', desc: 'A backup sealed with a password only you know. Scan it on a new phone to get your wallet back - useless to anyone without the password.' },
  { title: 'Nothing to hand over', desc: 'MeshPort stores no private keys, no recovery passwords and no seed phrases. It can’t move your funds, and neither can anyone who breaks into it.' },
]

const CHAT = [
  { title: 'End-to-end encrypted', desc: 'Messages are locked on your phone and only unlocked on theirs. MeshPort relays them but can’t read them.' },
  { title: 'Signed by your wallet', desc: 'Each chat key is signed by its wallet, and the app warns you if a contact’s key ever changes.' },
]

export function SelfCustody() {
  return (
    <section id="self-custody" className="scroll-mt-24 bg-surface/40">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <Reveal>
          <h2 className="text-[30px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[40px]">
            Your keys. Your money. Your messages.
          </h2>
          <p className="mt-5 text-[18px] leading-relaxed text-text-primary">
            Every MeshPort wallet is self-custodial, including the ones you open with Google or an email code. The key is made on your device, protected by your passkey and a Recovery QR only you can open, and never stored by MeshPort.
          </p>
          <p className="mt-6 text-[16px] leading-relaxed text-text-secondary">
            Sign in with Google, an email code or your own wallet; the key is created on this device; add a passkey and save your Recovery QR; then unlock on any device with either one.
          </p>
        </Reveal>

        <Reveal delay={0.05}>
          <dl className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
            {[...POINTS, ...CHAT].map(p => (
              <div key={p.title}>
                <dt className="text-[18px] font-bold text-text-primary">{p.title}</dt>
                <dd className="mt-1.5 text-[16px] leading-relaxed text-text-secondary">{p.desc}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  )
}
