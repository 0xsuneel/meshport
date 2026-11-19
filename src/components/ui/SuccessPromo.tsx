// A small "For you" card under a success receipt: one ad from Admin → Ads,
// picked at random each time (MeshPort's own features and partners alike).
// MeshPort's say "From MeshPort"; a partner's "Sponsored · <name>" and opens
// their site in a new tab. It sits below the receipt card, never inside it:
// people screenshot the receipt as proof of payment.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ChevronRight, ExternalLink } from 'lucide-react'
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
          display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit',
          background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)',
        }}>
        <AdArt ad={ad} size={44} radius={12} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ad.title}</span>
          {ad.body && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ad.body}</span>}
          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{ad.sponsor ? `Sponsored · ${ad.sponsor}` : 'From MeshPort'}</span>
        </span>
        {external ? <ExternalLink size={16} color="var(--text-muted)" style={{ flexShrink: 0 }} /> : <ChevronRight size={18} color="var(--text-muted)" style={{ flexShrink: 0 }} />}
      </button>
    </motion.div>
  )
}
