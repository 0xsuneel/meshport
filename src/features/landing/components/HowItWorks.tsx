import { Reveal } from './Reveal'

const STEPS = [
  { title: 'Create your wallet', desc: 'Create your MeshPort wallet and protect it with your device.' },
  { title: 'Fund it', desc: 'Receive USDC directly, or claim supported crosschain funds into your Arc wallet.' },
  { title: 'Pay', desc: 'Send USDC by username, QR, or directly inside chat.' },
  { title: 'Manage', desc: 'Swap, trade P2P, make bulk payments, and track your activity.' },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="max-w-2xl">
        <h2 className="text-[30px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[40px]">
          From zero to your first payment
        </h2>
        <p className="mt-5 text-[18px] leading-relaxed text-text-primary">
          Four steps, and the first one takes under a minute.
        </p>
      </Reveal>

      <Reveal delay={0.05} className="mt-12">
        <ol className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(s => (
            <li key={s.title}>
              <p className="text-[24px] font-extrabold tracking-tight text-text-primary">{s.title}</p>
              <p className="mt-1.5 text-[18px] leading-relaxed text-text-secondary">{s.desc}</p>
            </li>
          ))}
        </ol>
      </Reveal>
    </section>
  )
}
