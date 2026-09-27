// Card for a MeshPort personal payment link shared in chat
// (`/pay/<username>` or `/pay/<username>?amount=`). "Pay" opens the chat's
// own pay sheet when the link is the chat partner's (amount prefilled and
// fixed when the link has one); otherwise it opens the link's pay page.
import { Link2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { formatAmount } from '@/lib/utils'
import { PAY_LINK_EVENT, type PersonalPayLink } from '@/lib/payLinks'
import { useAuthStore } from '@/store'

export function PayLinkCard({ link, isMine }: { link: PersonalPayLink; isMine: boolean }) {
  const navigate = useNavigate()
  const myUsername = useAuthStore(s => (s.user as any)?.username as string | undefined)
  const own = !!myUsername && myUsername.toLowerCase().replace(/\.arc$/, '') === link.username
  const fg = isMine ? '#fff' : 'var(--text-primary)'
  const muted = isMine ? 'rgba(255,255,255,0.75)' : 'var(--text-secondary)'
  const pay = (e: React.MouseEvent) => {
    e.stopPropagation()
    // ChatPage handles it when the link belongs to the chat partner;
    // otherwise (nobody handled it) open the link's pay page.
    const ev = new CustomEvent(PAY_LINK_EVENT, { detail: { ...link, handled: false }, cancelable: true })
    window.dispatchEvent(ev)
    if (!(ev.detail as any).handled) navigate(`/pay/${link.username}${link.amount ? `?amount=${encodeURIComponent(link.amount)}` : ''}`)
  }
  return (
    <div onClick={e => e.stopPropagation()}
      style={{
        minWidth: 210, maxWidth: 280, marginBottom: 6, padding: '10px 12px', borderRadius: 12,
        background: isMine ? 'rgba(255,255,255,0.15)' : 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Link2 size={15} color={fg} />
        <span style={{ fontSize: 12, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Payment link</span>
      </div>
      <div style={{ fontSize: 13, color: fg, marginTop: 6 }}>Pay {link.username}.arc</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: fg, marginTop: 2 }}>
        {link.amount ? `$${formatAmount(Number(link.amount))} USDC` : 'Any amount'}
      </div>
      {!isMine && !own && (
        <button onClick={pay}
          style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          {link.amount ? `Pay $${formatAmount(Number(link.amount))}` : 'Pay'}
        </button>
      )}
    </div>
  )
}
