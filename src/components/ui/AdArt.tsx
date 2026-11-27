// An ad's picture: its uploaded image, or MeshPort's own icon for one of its
// features on that feature's colour (the tiles the "For you" card used).
import { useEffect, useState } from 'react'
import { ActionIcon } from './ActionIcon'
import { NavIcon } from '@/components/layout/navIcons'
import type { Ad } from '@/lib/ads'

export const AD_TILE: Record<string, string> = {
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
    <span style={{ ...box, color: '#fff', background: onBrand ? 'rgba(140,225,205,0.16)' : (AD_TILE[icon] ?? AD_TILE.hub) }}>
      {icon === 'chat' ? <NavIcon name="chat" size={Math.round(size * 0.55)} color="#fff" /> : <ActionIcon name={icon} size={Math.round(size * 0.55)} />}
    </span>
  )
}

// ── An ad's own colour (Home's banner panel) ────────────────────────────────
// Icon ads: their tile's gradient. Picture ads: the picture's main colour,
// read once per picture from a 24px copy of it (needs the image host to allow
// CORS - Supabase storage does); if it can't be read, a neutral slate.
const NEUTRAL = 'linear-gradient(150deg, #3A3F4B, #5B6272)'
const adColourCache = new Map<string, string>()

function pictureColour(url: string): Promise<string> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 24
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(NEUTRAL)
        ctx.drawImage(img, 0, 0, 24, 24)
        const d = ctx.getImageData(0, 0, 24, 24).data
        let r = 0, g = 0, b = 0, w = 0
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3]
          const max = Math.max(R, G, B), min = Math.min(R, G, B)
          // Skip see-through, near-white, near-black and grey pixels: the logo's colour, not its backing.
          if (A < 128 || max > 240 && min > 215 || max < 30 || max - min < 28) continue
          const k = (max - min) / 255
          r += R * k; g += G * k; b += B * k; w += k
        }
        if (w < 0.5) return resolve(NEUTRAL)
        const [h, sat] = rgbToHs(r / w, g / w, b / w)
        const s2 = Math.round(Math.min(70, Math.max(35, sat)))
        resolve(`linear-gradient(150deg, hsl(${h} ${s2}% 32%), hsl(${(h + 28) % 360} ${s2}% 44%))`)
      } catch { resolve(NEUTRAL) } // a tainted canvas (no CORS): neutral
    }
    img.onerror = () => resolve(NEUTRAL)
    img.src = url
  })
}

function rgbToHs(r: number, g: number, b: number): [number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (!d) return [0, 0]
  const l = (max + min) / 2
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = Math.round(h * 60); if (h < 0) h += 360
  return [h, s * 100]
}

/** The ad's own colour as a CSS background (a gradient). */
export function useAdColour(ad: Pick<Ad, 'image_url' | 'icon'>): string {
  const key = ad.image_url || `icon:${ad.icon ?? 'hub'}`
  const known = ad.image_url ? adColourCache.get(ad.image_url) : AD_TILE[ad.icon ?? 'hub'] ?? AD_TILE.hub
  const [found, setFound] = useState<{ key: string; bg: string } | null>(null)
  useEffect(() => {
    if (!ad.image_url || adColourCache.has(ad.image_url)) return
    let live = true
    const url = ad.image_url
    pictureColour(url).then(bg => { adColourCache.set(url, bg); if (live) setFound({ key: url, bg }) })
    return () => { live = false }
  }, [ad.image_url])
  return known ?? (found?.key === key ? found.bg : NEUTRAL)
}
