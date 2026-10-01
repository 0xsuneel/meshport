import { motion, useReducedMotion } from 'framer-motion'

// "Scanning chains" animation shared by Bring Funds, the Multichain Hub's
// Bring list and the Merchant Ledger's chains tab. Chain logos glide past a
// glowing scan beam inside a bordered card, so the scan is clearly visible
// instead of a line of grey "Checking chains…" text. `compact` is a slimmer
// strip used above an already-listed set of chains while it refreshes.
export function ChainScanner({ logos, title = 'Scanning chains…', subtitle, compact = false }: {
  logos: Array<{ src: string; alt: string }>
  title?: string
  subtitle?: string
  compact?: boolean
}) {
  const reduce = useReducedMotion()
  const size = compact ? 30 : 42
  const gap = compact ? 12 : 16
  const stripH = compact ? 46 : 70
  const loop = logos.length ? [...logos, ...logos] : []
  // Constant speed regardless of how many chains are listed.
  const duration = Math.max(6, logos.length * 0.9)

  return (
    <div role="status" aria-live="polite" style={{
      width: '100%', boxSizing: 'border-box', borderRadius: compact ? 16 : 20,
      padding: compact ? '10px 14px' : '18px 16px 16px',
      background: 'color-mix(in srgb, var(--brand) 8%, var(--surface))',
      border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)',
      display: 'flex', flexDirection: compact ? 'row' : 'column', alignItems: 'center', gap: compact ? 12 : 14,
    }}>
      <div style={{
        position: 'relative', flex: compact ? 1 : undefined, width: compact ? undefined : '100%', maxWidth: compact ? undefined : 320,
        height: stripH, overflow: 'hidden', minWidth: 0,
        WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)',
        maskImage: 'linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)',
      }}>
        <motion.div
          animate={reduce ? undefined : { x: ['0%', '-50%'] }}
          transition={{ duration, repeat: Infinity, ease: 'linear' }}
          style={{ position: 'absolute', top: '50%', left: 0, marginTop: -size / 2, display: 'flex', gap, alignItems: 'center', width: 'max-content' }}>
          {loop.map((l, i) => (
            <img key={i} src={l.src} alt={i < logos.length ? l.alt : ''} width={size} height={size}
              onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }}
              style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'block', objectFit: 'cover',
                background: 'var(--surface)', boxShadow: '0 0 0 1px var(--border)' }} />
          ))}
        </motion.div>

        {/* Scan beam: a bright core line, a soft glow and a ring the logos pass through. */}
        <div aria-hidden style={{
          position: 'absolute', top: 0, bottom: 0, left: '50%', width: 44, marginLeft: -22,
          background: 'radial-gradient(closest-side, color-mix(in srgb, var(--success) 28%, transparent), transparent)',
        }} />
        <motion.div aria-hidden
          animate={reduce ? undefined : { opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute', top: 2, bottom: 2, left: '50%', width: 3, marginLeft: -1.5, borderRadius: 3,
            background: 'linear-gradient(180deg, transparent, var(--success), transparent)',
            boxShadow: '0 0 10px var(--success)',
          }} />
        <div aria-hidden style={{
          position: 'absolute', top: '50%', left: '50%', width: size + 12, height: size + 12,
          marginTop: -(size + 12) / 2, marginLeft: -(size + 12) / 2, borderRadius: '50%',
          border: '2px solid color-mix(in srgb, var(--success) 70%, transparent)',
        }} />
      </div>

      <div style={{ textAlign: compact ? 'left' : 'center', flexShrink: 0, maxWidth: compact ? 150 : undefined }}>
        <p style={{ margin: 0, fontSize: compact ? 13 : 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</p>
        {subtitle && <p style={{ margin: '3px 0 0', fontSize: compact ? 11.5 : 13, color: 'var(--text-secondary)' }}>{subtitle}</p>}
      </div>
    </div>
  )
}
