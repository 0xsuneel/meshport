// The one "payment in progress" loader used on every payment screen, so a
// payment always looks the same while it's on its way: the animated MeshPort
// logo (MeshLoader), or at tiny sizes a soft brand ring with a sweeping arc.
// Pure CSS animation (see .mp-proc-* in index.css) — runs on the compositor
// and keeps spinning smoothly even while the page is busy signing/sending.
import { MeshLoader } from './MeshLoader'

export function ProcessingRing({ size = 80 }: { size?: number }) {
  // Payment screens show the animated MeshPort logo; the plain ring stays for
  // tiny inline spots (e.g. the swap arrow bubble) where the mark won't read.
  if (size >= 48) {
    return (
      <div role="progressbar" aria-label="Processing"
        style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <MeshLoader size={Math.round(size * 0.85)} label="Processing" />
      </div>
    )
  }
  const stroke = Math.max(3, Math.round(size / 20))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div className="mp-proc" role="progressbar" aria-label="Processing"
      style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0 }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke="color-mix(in srgb, var(--brand) 16%, transparent)" />
        <circle className="mp-proc-arc" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke="var(--brand)" strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c}`}
          style={{ transformOrigin: '50% 50%' }} />
      </svg>
      <span className="mp-proc-dot" style={{
        position: 'absolute', left: '50%', top: '50%', width: size * 0.22, height: size * 0.22,
        margin: `${-size * 0.11}px 0 0 ${-size * 0.11}px`, borderRadius: '50%', background: 'var(--brand)',
      }} />
    </div>
  )
}
