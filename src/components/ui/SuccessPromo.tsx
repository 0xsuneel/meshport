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

const PROMOS: Array<{ id: PromoFeature; to: string; title: string; line: string; cta: string; Icon: typeof Globe; tile: string; flag?: string }> = [
  { id: 'multichain', to: '/multichain', title: 'Multichain Hub', line: 'Your USDC across 20+ chains, in one place', cta: 'Open', Icon: Globe, tile: 'linear-gradient(135deg, #12665F, #2BA393)' },
  { id: 'swap', to: '/swap', title: 'Swap USDC ⇄ EURC', line: 'Change currency in seconds on Arc', cta: 'Swap', Icon: ArrowLeftRight, tile: 'linear-gradient(135deg, #2B5CE6, #5B8DEF)' },
  { id: 'p2p', to: '/p2p', title: 'P2P Marketplace', line: 'Buy and sell USDC safely with escrow', cta: 'Explore', Icon: Users, tile: 'linear-gradient(135deg, #C2410C, #F59E0B)', flag: 'p2p_enabled' },
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
  // The approved preview's "For you" card: a quiet card in the app's card
  // style - a coloured tile, the title, one line, and "From MeshPort" small
  // (where a partner's card would say "Sponsored · their site").
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
      transition={{ duration: 0.35, delay: revealed ? 0.35 : 0, ease: EASE_OUT }}
      style={{ width: '100%', flexShrink: 0 }}
    >
      <button type="button" onClick={() => navigate(promo.to)}
        className="w-full text-left active:scale-[0.99] transition-transform"
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit',
          background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)',
        }}>
        <span style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: promo.tile }}>
          <Icon size={22} strokeWidth={2.2} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{promo.title}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{promo.line}</span>
          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>From MeshPort</span>
        </span>
        <ChevronRight size={18} color="var(--text-muted)" style={{ flexShrink: 0 }} />
      </button>
    </motion.div>
  )
}
