import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Reveal } from './Reveal'
import { SECTIONS } from '@/features/profile/featureGuideData'

// Landing: a swipeable strip of real app screens from the Feature Guide,
// with a link to the full public guide (/guide).
const PICKS = ['home', 'pay', 'chat', 'hub', 'swap', 'self-custody', 'bulk', 'p2p']
const FEATURES = SECTIONS.flatMap(s => s.features)
const SHOWN = PICKS.map(id => FEATURES.find(f => f.id === id)).filter(Boolean) as typeof FEATURES

export function GuideSection() {
  const navigate = useNavigate()
  return (
    <section id="guide" className="scroll-mt-24 py-20 sm:py-28">
      <Reveal className="mx-auto max-w-2xl px-5 text-center sm:px-8">
        <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand-text">Feature guide</p>
        <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">See every screen before you start.</h2>
        <p className="mt-4 text-[15.5px] leading-relaxed text-text-secondary">
          {FEATURES.length} features, each with the real screen and simple steps - from your first sign-in to bulk payouts.
        </p>
      </Reveal>

      <div className="mt-12 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-4 sm:px-8 lg:mx-auto lg:max-w-7xl" style={{ scrollbarWidth: 'none' }}>
        {SHOWN.map(f => (
          <button key={f.id} onClick={() => navigate(`/guide#guide-${f.id}`)}
            className="w-[220px] flex-shrink-0 snap-start rounded-[22px] border border-border bg-surface p-3 text-left shadow-elevation-1 transition-transform hover:-translate-y-1">
            <div className="overflow-hidden rounded-2xl border border-border bg-bg">
              <img src={`/guide/${f.image}.jpg`} alt={`${f.title} screen`} width={390} height={780} loading="lazy" decoding="async" className="block aspect-[1/2] w-full object-cover object-top" />
            </div>
            <p className="mt-3 px-1 text-[14.5px] font-bold text-text-primary">{f.title}</p>
            <p className="mt-1 px-1 text-[12.5px] leading-relaxed text-text-secondary line-clamp-2">{f.summary}</p>
          </button>
        ))}
      </div>

      <div className="mt-8 flex justify-center px-5">
        <button onClick={() => navigate('/guide')}
          className="flex items-center gap-2 rounded-2xl bg-brand px-7 py-4 text-[15px] font-semibold text-white transition-transform active:scale-[0.98]">
          Open the full guide <ArrowRight size={16} />
        </button>
      </div>
    </section>
  )
}
