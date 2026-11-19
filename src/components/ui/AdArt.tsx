// An ad's picture: its uploaded image, or MeshPort's own icon for one of its
// features on that feature's colour (the tiles the "For you" card used).
import { useState } from 'react'
import { ActionIcon } from './ActionIcon'
import { NavIcon } from '@/components/layout/navIcons'
import type { Ad } from '@/lib/ads'

const TILE: Record<string, string> = {
  hub: 'linear-gradient(135deg, #12665F, #2BA393)',
  swap: 'linear-gradient(135deg, #2B5CE6, #5B8DEF)',
  p2p: 'linear-gradient(135deg, #C2410C, #F59E0B)',
  chat: 'linear-gradient(135deg, #0F766E, #14B8A6)',
  bulk: 'linear-gradient(135deg, #6D28D9, #A78BFA)',
}

/** Image ads: the picture fills the tile (light backing for logos with transparency). */
export function AdArt({ ad, size, radius, round = false, onBrand = false }: {
  ad: Pick<Ad, 'image_url' | 'icon' | 'title'>; size: number; radius?: number; round?: boolean
  /** On the brand-coloured Home banner: a soft white tile for icons. */
  onBrand?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const r = round ? '50%' : radius ?? 12
  const box = { width: size, height: size, borderRadius: r, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } as const
  if (ad.image_url && !failed) {
    return (
      <span style={{ ...box, background: '#fff' }}>
        <img src={ad.image_url} alt="" decoding="async" onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    )
  }
  const icon = ad.icon ?? 'hub'
  return (
    <span style={{ ...box, color: '#fff', background: onBrand ? 'rgba(140,225,205,0.16)' : (TILE[icon] ?? TILE.hub) }}>
      {icon === 'chat' ? <NavIcon name="chat" size={Math.round(size * 0.55)} color="#fff" /> : <ActionIcon name={icon} size={Math.round(size * 0.55)} />}
    </span>
  )
}
