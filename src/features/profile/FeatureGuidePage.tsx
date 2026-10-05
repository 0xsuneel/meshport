import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight, X } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { SECTIONS } from './featureGuideData'

// ── MeshPort Feature Guide ────────────────────────────────────────────────────
// Every feature, with a real screenshot of its screen (public/guide/*.jpg,
// captured from the app with sample data) and a few plain-language steps.
// Linked from Profile → Support. Written for end users, not developers.

/** isPublic: the /guide page for visitors who aren't signed in (no app links). */
export function FeatureGuidePage({ isPublic = false }: { isPublic?: boolean } = {}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [zoom, setZoom] = useState<{ title: string; image: string } | null>(null)

  // Opened from a landing-page card (/guide#guide-<id>): start at that feature.
  const { hash } = useLocation()
  useEffect(() => {
    if (!hash) return
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }), 60)
    return () => clearTimeout(t)
  }, [hash])

  const jump = (id: string) => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {(!isDesktop || isPublic) && (
            <button onClick={() => (isPublic ? navigate('/') : navigate(-1))} className="back-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Feature Guide</h1>
        </div>
      </div>

      <div className="px-4 pb-10 space-y-7 lg:max-w-[900px] lg:mx-auto">
        <p className="text-sm text-text-secondary px-1">Everything MeshPort can do, with the real screens. Tap a feature to jump to it.</p>

        {/* ── All features ── */}
        <div className="bg-surface border border-border rounded-3xl p-4 space-y-4">
          {SECTIONS.map(section => (
            <div key={section.heading}>
              <p className="text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-2 px-1">{section.heading}</p>
              <div className="flex flex-wrap gap-2">
                {section.features.map(f => (
                  <button key={f.id} onClick={() => jump(f.id)}
                    className="px-3 h-8 rounded-full border border-border bg-bg text-[12.5px] font-medium text-text-primary active:scale-95 transition-transform">
                    {f.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* ── Each feature ── */}
        {SECTIONS.map(section => (
          <div key={section.heading} className="space-y-3">
            <p className="text-xs font-bold text-text-secondary uppercase tracking-wider px-1">{section.heading}</p>
            {section.features.map(f => (
              <div key={f.id} id={`guide-${f.id}`} className="scroll-mt-24 bg-surface border border-border rounded-3xl p-4 flex flex-col sm:flex-row gap-4">
                <div className="self-center sm:self-start flex-shrink-0 flex gap-2">
                  {[f.image, ...(f.more ?? [])].map(img => (
                    <button key={img} onClick={() => setZoom({ title: f.title, image: img })} aria-label={`Enlarge ${f.title} screen`}
                      className="w-[150px] rounded-2xl overflow-hidden border border-border bg-bg shadow-elevation-1">
                      <img src={`/guide/${img}.jpg`} alt={`${f.title} screen`} width={390} height={780}
                        loading="lazy" decoding="async" className="block w-full aspect-[1/2] object-cover object-top" />
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15.5px] font-bold text-text-primary">{f.title}</p>
                  <p className="text-sm text-text-secondary leading-relaxed mt-1">{f.summary}</p>
                  <ol className="mt-3 space-y-2">
                    {f.steps.map((s, i) => (
                      <li key={i} className="flex gap-2.5 text-[13.5px] text-text-primary leading-relaxed">
                        <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-brand/10 text-brand text-[11px] font-bold flex items-center justify-center">{i + 1}</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                  {f.path && !isPublic && (
                    <button onClick={() => navigate(f.path!)}
                      className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-brand active:opacity-70">
                      Open {f.title} <ChevronRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
        {isPublic && (
          <button onClick={() => navigate('/auth')}
            className="w-full h-12 rounded-2xl bg-brand text-white text-sm font-semibold active:scale-[0.98] transition-transform">
            Launch MeshPort
          </button>
        )}
        <p className="text-[11.5px] text-text-muted text-center px-4">Some screens show sample names and amounts.</p>
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 mp-fade-in" style={{ background: 'rgba(0,0,0,0.75)' }} onClick={() => setZoom(null)}>
          <button onClick={() => setZoom(null)} aria-label="Close"
            className="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/15 flex items-center justify-center">
            <X className="w-5 h-5 text-white" />
          </button>
          <img src={`/guide/${zoom.image}.jpg`} alt={`${zoom.title} screen`}
            className="max-h-full max-w-full rounded-3xl shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
