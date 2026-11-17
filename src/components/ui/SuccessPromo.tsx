// A small "from MeshPort" card under a success receipt (preview "A", 17 Nov):
// one of the app's own features, opening its real page. Never an invented
// offer - a paid partner card can take this slot later, labelled "Sponsored".
// It sits below the receipt card, never inside it: people screenshot the
// receipt as proof of payment.
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeftRight, ChevronRight, Globe, Users } from 'lucide-react'
import { useSettingsStore } from '@/store/settingsStore'
import { EASE_OUT } from '@/lib/motion'

export type PromoFeature = 'multichain' | 'swap' | 'p2p'

const PROMOS: Array<{ id: PromoFeature; to: string; title: string; line: string; cta: string; Icon: typeof Globe; flag?: string }> = [
  { id: 'multichain', to: '/multichain', title: 'Multichain Hub', line: 'Your USDC across 20+ chains, in one place', cta: 'Open', Icon: Globe },
  { id: 'swap', to: '/swap', title: 'Swap USDC ⇄ EURC', line: 'Change currency in seconds on Arc', cta: 'Swap', Icon: ArrowLeftRight },
  { id: 'p2p', to: '/p2p', title: 'P2P Marketplace', line: 'Buy and sell USDC safely with escrow', cta: 'Explore', Icon: Users, flag: 'p2p_enabled' },
]

/** `exclude`: the feature this receipt is for (Swap's receipt never shows Swap). */
export function SuccessPromo({ exclude, revealed = true }: { exclude?: PromoFeature; revealed?: boolean }) {
  const navigate = useNavigate()
  const settings = useSettingsStore(s => s.settings)
  // One card per receipt, picked once (no change while it's on screen); only
  // features this account can open.
  const promo = useMemo(() => {
    const open = PROMOS.filter(p => p.id !== exclude && (!p.flag || settings[p.flag]?.enabled !== false))
    return open.length ? open[Math.floor(Math.random() * open.length)] : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exclude])
  if (!promo) return null
  const { Icon } = promo
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: 0.35, delay: revealed ? 0.35 : 0, ease: EASE_OUT }}
      style={{ maxWidth: 480, width: '100%', margin: '14px auto auto', flexShrink: 0 }}
    >
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 6px 6px' }}>
        From MeshPort
      </p>
      <button type="button" onClick={() => navigate(promo.to)}
        className="w-full text-left active:scale-[0.99] transition-transform"
        style={{
          position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 22, border: 'none', color: '#fff',
          background: 'linear-gradient(135deg, #12665F 0%, #1C8A7F 55%, #2BA393 100%)', cursor: 'pointer',
        }}>
        <span aria-hidden style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(115deg, rgba(255,255,255,.07) 0 10px, transparent 10px 20px)' }} />
        <span style={{ position: 'relative', width: 46, height: 46, borderRadius: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.18)' }}>
          <Icon size={22} strokeWidth={2} />
        </span>
        <span style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{promo.title}</span>
          <span style={{ display: 'block', fontSize: 12.5, opacity: 0.9 }}>{promo.line}</span>
        </span>
        <span style={{ position: 'relative', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 2, background: '#fff', color: '#12665F', fontWeight: 800, fontSize: 12.5, padding: '8px 10px 8px 12px', borderRadius: 999 }}>
          {promo.cta}<ChevronRight size={14} strokeWidth={2.6} />
        </span>
      </button>
    </motion.div>
  )
}
