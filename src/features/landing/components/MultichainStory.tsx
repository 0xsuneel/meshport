import { Layers, ArrowRight } from 'lucide-react'
import { Reveal } from './Reveal'

// Count reflects src/blockchain/chains.ts (EXTERNAL_CHAINS registry) — kept
// as a single readable number here rather than hardcoding a chain list, so
// this stays correct as the registry grows without another copy to update.
const SUPPORTED_CHAIN_COUNT = 21

export function MultichainStory() {
  return (
    <section className="bg-surface/40 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-10">
          <Reveal className="order-2 flex justify-center lg:order-1">
            <div
              className="flex w-full max-w-[380px] flex-col gap-3 rounded-[24px] border border-border bg-bg p-6"
              style={{ boxShadow: '0 20px 60px -20px rgba(0,0,0,0.18)' }}
            >
              <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted">Claimable</p>
              {[
                { chain: 'Base Sepolia', amount: '48.20 USDC' },
                { chain: 'Arbitrum Sepolia', amount: '12.00 USDC' },
                { chain: 'Avalanche Fuji', amount: '5.75 USDC' },
              ].map(row => (
                <div key={row.chain} className="flex items-center justify-between rounded-2xl border border-border bg-surface px-4 py-3.5">
                  <span className="text-[13.5px] font-semibold text-text-primary">{row.chain}</span>
                  <span className="text-[13.5px] font-bold text-brand">{row.amount}</span>
                </div>
              ))}
              <button className="mt-1 flex items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-3.5 text-[14px] font-bold text-white">
                Claim to Arc
                <ArrowRight size={15} />
              </button>
            </div>
          </Reveal>

          <Reveal delay={0.05} className="order-1 lg:order-2">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/12 text-brand">
              <Layers size={22} />
            </div>
            <h2 className="text-[28px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[36px]">
              Your USDC shouldn't feel trapped on one chain.
            </h2>
            <p className="mt-4 max-w-[460px] text-[15.5px] leading-relaxed text-text-secondary">
              MeshPort brings supported crosschain USDC into a simpler payment experience, so you can move funds into your Arc wallet without managing a separate workflow for every network.
            </p>
            <p className="mt-4 text-[13.5px] font-medium text-text-muted">
              {SUPPORTED_CHAIN_COUNT} supported testnet networks today, via Circle's CCTP infrastructure.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
