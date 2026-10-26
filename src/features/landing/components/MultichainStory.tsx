import { ArrowRight } from 'lucide-react'
import { Reveal } from './Reveal'

// Count reflects src/blockchain/chains.ts (EXTERNAL_CHAINS registry) - kept
// as a single readable number here rather than hardcoding a chain list, so
// this stays correct as the registry grows without another copy to update.
const SUPPORTED_CHAIN_COUNT = 21

export function MultichainStory() {
  return (
    <section className="bg-surface/40 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-10">
          <Reveal className="order-2 flex justify-center lg:order-1">
            <div data-ui className="flex w-full max-w-[420px] flex-col gap-3 rounded-[24px] border border-border bg-bg p-6">
              <p className="text-[15px] font-semibold text-text-secondary">Ready to claim · 65.95 USDC</p>
              {[
                { chain: 'Base Sepolia', amount: '48.20 USDC' },
                { chain: 'Arbitrum Sepolia', amount: '12.00 USDC' },
                { chain: 'Avalanche Fuji', amount: '5.75 USDC' },
              ].map(row => (
                <div key={row.chain} className="flex items-center justify-between rounded-2xl border border-border bg-surface px-4 py-3.5">
                  <span className="text-[16px] font-semibold text-text-primary">{row.chain}</span>
                  <span className="text-[16px] font-bold tabular-nums text-brand-text">{row.amount}</span>
                </div>
              ))}
              <button className="mt-1 flex items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3.5 text-[16px] font-bold text-white">
                Claim to Arc
                <ArrowRight size={15} />
              </button>
            </div>
          </Reveal>

          <Reveal delay={0.05} className="order-1 lg:order-2">
            <h2 className="text-[30px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[40px]">
              Bring your USDC in from other chains.
            </h2>
            <p className="mt-5 max-w-[500px] text-[18px] leading-relaxed text-text-primary">
              MeshPort brings supported crosschain USDC into a simpler payment experience, so you can move funds into your Arc wallet without managing a separate workflow for every network.
            </p>
            <p className="mt-4 text-[16px] text-text-secondary">
              {SUPPORTED_CHAIN_COUNT} supported testnet networks today, via Circle's CCTP infrastructure.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
