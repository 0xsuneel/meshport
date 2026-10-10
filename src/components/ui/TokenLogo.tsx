import { useState } from 'react'

// The real token logos, shipped with the app (public/logos/tokens/) so they
// show offline and never depend on a third-party image host. Falls back to
// the coloured symbol circle if the file can't load.
export type TokenLogoSymbol = 'USDC' | 'EURC' | 'cirBTC'
export const TOKEN_LOGO_SRC: Record<TokenLogoSymbol, string> = {
  USDC:   '/logos/tokens/usdc.png',
  EURC:   '/logos/tokens/eurc.png',
  cirBTC: '/logos/tokens/cirbtc.png',
}
const FALLBACK: Record<TokenLogoSymbol, { ch: string; bg: string }> = {
  USDC:   { ch: '$', bg: 'var(--usdc-icon)' },
  EURC:   { ch: '€', bg: 'var(--usdc-icon)' },
  cirBTC: { ch: '₿', bg: '#F7931A' },
}

export function TokenLogo({ token, size = 22 }: { token: string; size?: number }) {
  const t = (token in TOKEN_LOGO_SRC ? token : 'USDC') as TokenLogoSymbol
  const [ok, setOk] = useState(true)
  const box = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const
  if (ok) return <img src={TOKEN_LOGO_SRC[t]} alt={t} width={size} height={size} draggable={false} onError={() => setOk(false)} style={{ ...box, display: 'block', objectFit: 'cover' }} />
  return (
    <span style={{ ...box, background: FALLBACK[t].bg, color: '#fff', fontWeight: 700, fontSize: Math.round(size * 0.45),
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{FALLBACK[t].ch}</span>
  )
}
