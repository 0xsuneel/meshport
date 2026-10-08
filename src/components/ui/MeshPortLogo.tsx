/**
 * The MeshPort logo tile (same drawing as public/favicon.svg), drawn inline
 * so it shows with the first paint instead of loading a moment later. One
 * component so Sign in, Lock and About show the same tile and shadow.
 */
export function MeshPortLogo({ className = '' }: { className?: string }) {
  return (
    <svg role="img" aria-label="MeshPort" viewBox="8 8 184 184"
      className={`shadow-elevation-2 ${className}`}
      // 23% matches the tile's own corner (rx 42 of 184), so the shadow hugs it.
      style={{ display: 'block', borderRadius: '23%' }}>
      <rect x="10" y="10" width="180" height="180" rx="42" fill="#FFFFFF" stroke="#DCE5E3" strokeWidth="2"/>
      <g stroke="#0F5C57" strokeWidth="10" strokeLinecap="round"><line x1="100" y1="100" x2="62" y2="64"/><line x1="100" y1="100" x2="146" y2="58"/><line x1="100" y1="100" x2="150" y2="118"/><line x1="100" y1="100" x2="108" y2="152"/><line x1="100" y1="100" x2="54" y2="142"/></g>
      <g fill="#FFFFFF" stroke="#0F5C57" strokeWidth="10"><circle cx="62" cy="64" r="12"/><circle cx="146" cy="58" r="13"/><circle cx="150" cy="118" r="9"/><circle cx="108" cy="152" r="8"/><circle cx="54" cy="142" r="16"/><circle cx="100" cy="100" r="22"/></g>
    </svg>
  )
}
