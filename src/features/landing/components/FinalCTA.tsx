import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Reveal } from './Reveal'

export function FinalCTA() {
  const navigate = useNavigate()
  return (
    <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8 sm:pb-28">
      <Reveal>
        <div
          className="relative overflow-hidden rounded-[24px] px-6 py-16 text-center sm:px-16 sm:py-20"
          style={{ background: 'var(--brand)' }}
        >
          <h2 className="text-[28px] font-extrabold tracking-tight text-white sm:text-[38px]">
            USDC Payments, Made Simple.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[15.5px] leading-relaxed text-white/80">
            Create your wallet in under a minute and send your first payment on Arc Testnet.
          </p>
          <button
            onClick={() => navigate('/auth')}
            className="mx-auto mt-8 flex items-center justify-center gap-2 rounded-2xl bg-white px-7 py-4 text-[15px] font-bold text-[color:var(--brand)] shadow-elevation-2 transition-transform active:scale-[0.98]"
          >
            Launch MeshPort
            <ArrowRight size={17} />
          </button>
        </div>
      </Reveal>
    </section>
  )
}
