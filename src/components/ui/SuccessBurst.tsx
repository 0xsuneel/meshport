import { motion } from 'framer-motion'

/**
 * Shared "hero" visual for every payment-success screen (Send/Pay, Chat Pay,
 * Swap, Multichain Transfer, Multichain Claim). Each variant choreographs a
 * different lead-in so the five screens read as their own moment — sent,
 * exchanged, bridged, claimed — instead of one template reused everywhere,
 * while keeping the same checkmark payoff, footprint, and container size so
 * every screen still reads as one consistent UI (callers keep their own
 * heading/details-card/buttons unchanged, which now share identical
 * typography across all five screens). Flat color only, no glow/blur,
 * matching the rest of the design system.
 */

type BurstVariant = 'send' | 'swap' | 'chat' | 'transfer' | 'claim'

const DOT_COLORS = ['var(--brand)', 'var(--avatar-3)', 'var(--success)', 'var(--avatar-4)']

function Checkmark({ circle, stroke, delay = 0.2, rotateFrom }: { circle: number; stroke: number; delay?: number; rotateFrom?: number }) {
  const svgSize = Math.round(circle * 0.48)
  return (
    <motion.div
      initial={{ scale: 0.5, opacity: 0, rotate: rotateFrom ?? 0 }}
      animate={{ scale: 1, opacity: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 170, damping: 15 }}
      style={{
        width: circle, height: circle, borderRadius: '50%',
        background: 'color-mix(in srgb, var(--success) 15%, transparent)',
        border: '2px solid color-mix(in srgb, var(--success) 35%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative', zIndex: 1,
      }}
    >
      <motion.svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay }} />
      </motion.svg>
    </motion.div>
  )
}

export function SuccessBurst({ variant, height = 170, circle = 96 }: { variant: BurstVariant; height?: number; circle?: number }) {
  const stroke = circle >= 94 ? 3 : 2.6

  if (variant === 'send') {
    // Sent — an arrow streaks out and away while two rings ping outward,
    // reading unambiguously as "this left and is on its way."
    return (
      <div style={{ position: 'relative', width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {[0, 0.35].map((delay) => (
          <motion.div key={delay}
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 2.1, opacity: 0 }}
            transition={{ duration: 1.15, delay: delay + 0.1, ease: 'easeOut' }}
            style={{ position: 'absolute', width: circle, height: circle, borderRadius: '50%', border: '2px solid var(--success)' }}
          />
        ))}
        <motion.svg
          width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"
          initial={{ opacity: 0, x: -10, y: 10 }}
          animate={{ opacity: [0, 1, 0], x: [-10, 22, 40], y: [10, -22, -40] }}
          transition={{ duration: 0.55, delay: 0.05, ease: 'easeIn' }}
          style={{ position: 'absolute' }}
        >
          <path d="M7 17L17 7M17 7H9M17 7V15" />
        </motion.svg>
        <Checkmark circle={circle} stroke={stroke} />
      </div>
    )
  }

  if (variant === 'chat') {
    // Coin drop — small coin-colored dots tumble in from above and settle
    // around the circle, like change landing after a payment.
    const coins = [
      { x: -46, delay: 0.05 }, { x: -18, delay: 0.16 }, { x: 14, delay: 0.1 }, { x: 44, delay: 0.22 },
    ]
    return (
      <div style={{ position: 'relative', width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {coins.map((c, i) => (
          <motion.span key={i}
            initial={{ opacity: 0, y: -60, x: c.x, rotate: 0 }}
            animate={{ opacity: [0, 1, 1, 0], y: [-60, 4, 0, 0], rotate: [0, 200, 260, 260] }}
            transition={{ duration: 1.1, delay: c.delay, ease: 'easeOut', times: [0, 0.4, 0.55, 1] }}
            style={{ position: 'absolute', top: '18%', width: 9, height: 9, borderRadius: '50%', background: DOT_COLORS[i % DOT_COLORS.length] }}
          />
        ))}
        <Checkmark circle={circle} stroke={stroke} delay={0.32} />
      </div>
    )
  }

  if (variant === 'swap') {
    // Rotation seal — an arc of dots spins a full turn into place and the
    // checkmark itself turns in with them, reading as an exchange rather
    // than a simple pop-in.
    const arcDots = Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2
      const r = circle / 2 + 14
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r }
    })
    return (
      <div style={{ position: 'relative', width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <motion.div
          initial={{ rotate: -150, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          transition={{ duration: 0.85, ease: [0.34, 1.56, 0.64, 1] }}
          style={{ position: 'absolute', width: 0, height: 0 }}
        >
          {arcDots.map((d, i) => (
            <span key={i} style={{
              position: 'absolute', left: d.x, top: d.y, width: 5, height: 5, borderRadius: '50%',
              background: DOT_COLORS[i % DOT_COLORS.length], transform: 'translate(-50%, -50%)',
            }} />
          ))}
        </motion.div>
        <Checkmark circle={circle} stroke={stroke} delay={0.4} rotateFrom={-180} />
      </div>
    )
  }

  if (variant === 'transfer') {
    // Bridge crossing — a dashed line draws in first, then chain-colored
    // dots travel along it and converge into the circle, echoing funds
    // hopping across a bridge into Arc.
    const corners = [
      { x: -100, y: 0 }, { x: 100, y: 0 }, { x: -70, y: -40 }, { x: 70, y: -40 },
    ]
    return (
      <div style={{ position: 'relative', width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <motion.div
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: [0, 0.5, 0] }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          style={{ position: 'absolute', width: circle + 90, height: 2, background: 'repeating-linear-gradient(90deg, var(--border) 0 6px, transparent 6px 12px)' }}
        />
        {corners.map((c, i) => (
          <motion.span key={i}
            initial={{ opacity: 0, x: c.x, y: c.y }}
            animate={{ opacity: [0, 1, 0], x: 0, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 + i * 0.08, ease: 'easeIn' }}
            style={{ position: 'absolute', width: 7, height: 7, borderRadius: '50%', background: DOT_COLORS[i % DOT_COLORS.length] }}
          />
        ))}
        <Checkmark circle={circle} stroke={stroke} delay={0.4} />
      </div>
    )
  }

  // claim — settle drop: particles fall from above and land with a soft
  // bounce while the circle itself rises to meet them, echoing funds
  // arriving and settling into the wallet.
  const drops = [
    { x: -34, delay: 0.05 }, { x: 0, delay: 0.14 }, { x: 34, delay: 0.09 },
  ]
  return (
    <div style={{ position: 'relative', width: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {drops.map((d, i) => (
        <motion.span key={i}
          initial={{ opacity: 0, y: -80, x: d.x }}
          animate={{ opacity: [0, 1, 1, 0], y: [-80, 2, -8, 30] }}
          transition={{ duration: 0.8, delay: d.delay, ease: 'easeIn', times: [0, 0.55, 0.7, 1] }}
          style={{ position: 'absolute', top: '18%', width: 7, height: 7, borderRadius: '50%', background: DOT_COLORS[i % DOT_COLORS.length] }}
        />
      ))}
      <motion.div
        initial={{ y: 14, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.3, ease: 'easeOut' }}
      >
        <Checkmark circle={circle} stroke={stroke} delay={0.45} />
      </motion.div>
    </div>
  )
}
