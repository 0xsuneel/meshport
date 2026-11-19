// A small "For you" card under a success receipt: one ad from Admin → Ads,
// picked at random each time (MeshPort's own features and partners alike).
// MeshPort's say "From MeshPort"; a partner's "Sponsored · <name>" and opens
// their site in a new tab. It sits below the receipt card, never inside it:
// people screenshot the receipt as proof of payment.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { EASE_OUT } from '@/lib/motion'
import { useAds, openAd, isExternalAd, type Ad } from '@/lib/ads'
import { AdArt } from './AdArt'

export type PromoFeature = 'multichain' | 'swap' | 'p2p'
const FEATURE_LINK: Record<PromoFeature, string> = { multichain: '/multichain', swap: '/swap', p2p: '/p2p' }

/** `exclude`: the feature this receipt is for (Swap's receipt never shows Swap). */
export function SuccessPromo({ exclude, revealed = true, instant = false }: { exclude?: PromoFeature; revealed?: boolean; /** Shown by its parent's reveal: no fade of its own. */ instant?: boolean }) {
  const navigate = useNavigate()
  const ads = useAds('success')
  // One ad per receipt, picked once - it never changes while it's on screen.
  const [ad, setAd] = useState<Ad | null>(null)
  const key = ads.map(a => a.id).join(',')
  useEffect(() => {
    if (ad) return
    const open = ads.filter(a => !exclude || a.link !== FEATURE_LINK[exclude])
    if (open.length) setAd(open[Math.floor(Math.random() * open.length)])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, exclude])
  if (!ad) return null
  const external = isExternalAd(ad)
  return (
    <motion.div
      initial={instant ? false : { opacity: 0, y: 8 }}
      animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: 0.35, delay: revealed ? 0.35 : 0, ease: EASE_OUT }}
      style={{ width: '100%', flexShrink: 0 }}
    >
      <button type="button" onClick={() => openAd(ad, navigate)}
        className="w-full text-left active:scale-[0.99] transition-transform"
        style={{
          display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
          background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)',
        }}>
        <span style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <AdArt ad={ad} size={56} radius={16} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.02em' }}>
              <span style={{ color: ad.sponsor ? 'var(--text-muted)' : 'var(--brand-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ad.sponsor ? `Sponsored · ${ad.sponsor}` : 'From MeshPort'}</span>
              {ad.sponsor && <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Ad</span>}
            </span>
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ad.title}</span>
            {ad.body && <span style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{ad.body}</span>}
          </span>
        </span>
        <span style={{
          height: 42, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '0 12px', fontSize: 14, fontWeight: 700,
          background: external ? 'color-mix(in srgb, var(--brand) 14%, var(--surface))' : 'var(--brand)',
          color: external ? 'var(--brand-text)' : '#fff',
        }}>
          <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{external ? `Explore ${ad.title}` : `Try ${ad.title}`}</span>
          {external ? <ExternalLink size={15} style={{ flexShrink: 0 }} /> : <ArrowRight size={15} style={{ flexShrink: 0 }} />}
        </span>
      </button>
    </motion.div>
  )
}
