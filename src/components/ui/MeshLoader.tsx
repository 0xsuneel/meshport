/**
 * MeshPort's animated logo ("Pulse + Twinkle"): a glow travels around the
 * network — each outer ring pops and lights up in turn while the hub
 * breathes. Used as the app's loading indicator. Stroke uses currentColor,
 * so the colour comes from `color` (default: brand teal).
 */
const LINES: [number, number, number, number][] = [
  [84.0, 84.9, 70.7, 72.3], [116.2, 85.2, 136.4, 66.8], [120.7, 107.5, 141.5, 115.0],
  [103.3, 121.7, 106.8, 144.1], [83.8, 114.8, 65.8, 131.2],
]
const NODES: [number, number, number][] = [[62, 64, 12], [146, 58, 13], [150, 118, 9], [108, 152, 8], [54, 142, 16]]

export const MESH_LOADER_CSS = `
.mpl .n,.mpl .hub{transform-box:fill-box;transform-origin:center}
.mpl .n{animation:mplPopTw 1.8s ease-in-out infinite}
.mpl .l{animation:mplTw 1.8s ease-in-out infinite}
.mpl .s2{animation-delay:.2s}.mpl .s3{animation-delay:.4s}.mpl .s4{animation-delay:.6s}.mpl .s5{animation-delay:.8s}
.mpl .hub{animation:mplBreathe 1.8s ease-in-out infinite}
@keyframes mplPopTw{0%,60%,100%{transform:scale(1);opacity:.35}22%{transform:scale(1.38);opacity:1}38%{opacity:1}}
@keyframes mplTw{0%,100%{opacity:.3}35%{opacity:1}}
@keyframes mplBreathe{0%,100%{transform:scale(1)}50%{transform:scale(.86)}}
@media (prefers-reduced-motion: reduce){.mpl .n,.mpl .l,.mpl .hub{animation:none;opacity:1}}
`

export function MeshLoader({ size = 56, color = 'var(--brand)', label = 'Loading' }: { size?: number; color?: string; label?: string }) {
  return (
    <svg className="mpl" width={size} height={size} viewBox="28 35 140 140" role="img" aria-label={label}
      style={{ color, overflow: 'visible', display: 'block' }}>
      <style>{MESH_LOADER_CSS}</style>
      <g stroke="currentColor" strokeWidth={10}>
        {LINES.map(([x1, y1, x2, y2], i) => <line key={i} className={`l s${i + 1}`} x1={x1} y1={y1} x2={x2} y2={y2} />)}
      </g>
      <g fill="none" stroke="currentColor" strokeWidth={10}>
        {NODES.map(([cx, cy, r], i) => <circle key={i} className={`n s${i + 1}`} cx={cx} cy={cy} r={r} />)}
      </g>
      <circle className="hub" cx={100} cy={100} r={22} fill="none" stroke="currentColor" strokeWidth={10} />
    </svg>
  )
}
