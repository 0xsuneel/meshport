// The quiet line at the foot of a success screen and a history card (18 Nov
// 2026): MeshPort's mark and name, then "Powered by Arc | Circle" - the
// network the payment settled on and the issuer of the money. All in one
// muted grey, marks included (Arc's is the chain logo the app already shows,
// greyed); Circle is its name only.
//
// One straight line: every part is a 12px-tall box with the same line height
// (text at line-height 12px, marks 12px), so the words, the two-line
// "Powered by" and the marks all sit centred on the same line.

const H = 12

export function PoweredByFooter({ style }: { style?: React.CSSProperties }) {
  const grey = 'var(--text-muted)'
  const word: React.CSSProperties = { display: 'block', height: H, fontSize: 10.5, lineHeight: `${H}px`, fontWeight: 800, letterSpacing: '-0.15px', whiteSpace: 'nowrap' }
  const sep = <span aria-hidden style={{ width: 1, height: 10, background: grey, opacity: 0.45, flex: 'none' }} />
  const box: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3, height: H }
  return (
    <div aria-label="MeshPort, powered by Arc and Circle"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '16px 0 6px', color: grey, opacity: 0.85, ...style }}>
      <span style={box}>
        {/* MeshPort's mark, line only, in the footer's grey. */}
        <svg aria-hidden viewBox="40 40 120 124" width={H} height={H} style={{ display: 'block', flex: 'none' }}>
          <g stroke="currentColor" strokeWidth="12" strokeLinecap="round"><line x1="100" y1="100" x2="62" y2="64" /><line x1="100" y1="100" x2="146" y2="58" /><line x1="100" y1="100" x2="150" y2="118" /><line x1="100" y1="100" x2="108" y2="152" /><line x1="100" y1="100" x2="54" y2="142" /></g>
          <g fill="var(--bg)" stroke="currentColor" strokeWidth="11"><circle cx="62" cy="64" r="12" /><circle cx="146" cy="58" r="13" /><circle cx="150" cy="118" r="9" /><circle cx="108" cy="152" r="8" /><circle cx="54" cy="142" r="16" /><circle cx="100" cy="100" r="22" /></g>
        </svg>
        <b style={word}>MeshPort</b>
      </span>
      {sep}
      <span style={box}>
        <span style={{ display: 'block', height: H, fontSize: 6, fontWeight: 600, lineHeight: `${H / 2}px`, textAlign: 'right', whiteSpace: 'nowrap' }}>Powered<br />by</span>
        <img src="/logos/chains/arc.svg" alt="" width={10} height={10} style={{ display: 'block', flex: 'none', filter: 'grayscale(1) contrast(.8)', opacity: 0.75 }} />
        <b style={word}>Arc</b>
      </span>
      {sep}
      <span style={box}>
        <b style={{ ...word, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase' }}>Circle</b>
      </span>
    </div>
  )
}
