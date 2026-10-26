import { Reveal } from './Reveal'

// What MeshPort runs on, as four plain facts on one tone band.
const TECH = [
  { name: 'Arc', desc: 'Stablecoin-native L1 with sub-second finality' },
  { name: 'USDC', desc: 'The native stablecoin and gas token on Arc' },
  { name: 'CCTP', desc: "Circle's crosschain USDC infrastructure" },
  { name: 'Multichain', desc: 'Supported networks, one simpler experience' },
]

export function TrustedTech() {
  return (
    <section className="bg-surface/40">
      <Reveal className="mx-auto grid max-w-7xl grid-cols-1 gap-x-8 gap-y-6 px-5 py-12 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
        {TECH.map(t => (
          <div key={t.name}>
            <p className="text-[18px] font-bold text-text-primary">{t.name}</p>
            <p className="mt-1 text-[16px] leading-snug text-text-secondary">{t.desc}</p>
          </div>
        ))}
      </Reveal>
    </section>
  )
}
