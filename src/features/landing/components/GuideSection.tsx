import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Reveal } from './Reveal'
import { SECTIONS } from '@/features/profile/featureGuideData'

// Landing: a grid of real app screens from the Feature Guide,
// with a link to the full public guide (/guide).
const PICKS = ['home', 'pay', 'chat', 'hub', 'swap', 'self-custody', 'bulk', 'p2p']
const FEATURES = SECTIONS.flatMap(s => s.features)
const SHOWN = PICKS.map(id => FEATURES.find(f => f.id === id)).filter(Boolean) as typeof FEATURES

export function GuideSection() {
  const navigate = useNavigate()
  return (
    <section id="guide" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="max-w-2xl">
        <h2 className="text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[40px]">See every screen before you start.</h2>
        <p className="mt-4 text-[18px] leading-relaxed text-text-primary">
          {FEATURES.length} features, each with the real screen and simple steps - from your first sign-in to bulk payouts.
        </p>
      </Reveal>

      <div className="mt-12 grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 lg:grid-cols-4">
        {SHOWN.map(f => (
          <button key={f.id} onClick={() => navigate(`/guide#guide-${f.id}`)}
            className="group text-left">
            <div data-ui className="overflow-hidden rounded-[20px] border border-border bg-bg transition-transform group-hover:-translate-y-1">
              <img data-ui src={`/guide/${f.image}.jpg`} alt={`${f.title} screen`} width={390} height={780} loading="lazy" decoding="async" className="block aspect-[1/2] w-full object-cover object-top" />
            </div>
            <p className="mt-3 text-[18px] font-bold text-text-primary">{f.title}</p>
            <p className="mt-1 text-[16px] leading-relaxed text-text-secondary line-clamp-3">{f.summary}</p>
          </button>
        ))}
      </div>

      <div className="mt-10">
        <button onClick={() => navigate('/guide')}
          className="flex items-center gap-2 rounded-2xl bg-brand px-7 py-4 text-[16px] font-semibold text-white transition-transform active:scale-[0.98]">
          Open the full guide <ArrowRight size={16} />
        </button>
      </div>
    </section>
  )
}
