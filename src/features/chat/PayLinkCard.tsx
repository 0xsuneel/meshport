// Card for a MeshPort personal payment link shared in chat
// (`/paylink/<username>` or `/paylink/<username>?amount=`; old `/pay/…` links too). "Pay" opens the chat's
// own pay sheet when the link is the chat partner's (amount prefilled and
// fixed when the link has one); otherwise it opens the link's pay page.
import { Link2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { formatAmount } from '@/lib/utils'
import { PAY_LINK_EVENT, type PersonalPayLink } from '@/lib/payLinks'
import { useAuthStore } from '@/store'
import { cardInnerWidth } from './chatCard'

export function PayLinkCard({ link, isMine }: { link: PersonalPayLink; isMine: boolean }) {
  const navigate = useNavigate()
  const myUsername = useAuthStore(s => (s.user as any)?.username as string | undefined)
  const own = !!myUsername && myUsername.toLowerCase().replace(/\.arc$/, '') === link.username
  const pay = (e: React.MouseEvent) => {
    e.stopPropagation()
    // ChatPage handles it when the link belongs to the chat partner;
    // otherwise (nobody handled it) open the link's pay page.
    const ev = new CustomEvent(PAY_LINK_EVENT, { detail: { ...link, handled: false }, cancelable: true })
    window.dispatchEvent(ev)
    if (!(ev.detail as any).handled) navigate(`/paylink/${link.username}${link.amount ? `?amount=${encodeURIComponent(link.amount)}` : ''}`)
  }
  // Same colour-band card as payments and bills (brand band for a link),
  // at the shared chat card width.
  return (
    <div onClick={e => e.stopPropagation()}
      style={{
        width: cardInnerWidth(isMine), maxWidth: '100%', marginBottom: 2, borderRadius: 13, overflow: 'hidden',
        background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'left',
        boxShadow: '0 6px 16px -10px rgba(0,0,0,0.35)',
      }}>
      <div style={{ position: 'relative', overflow: 'hidden', padding: '13px 13px 14px', color: '#fff', background: 'linear-gradient(135deg, #3E8E86, #155A55)' }}>
        <span aria-hidden style={{ position: 'absolute', right: -18, top: -18, width: 72, height: 72, borderRadius: '50%', border: '12px solid rgba(255,255,255,0.12)' }} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, opacity: 0.92, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <Link2 size={13} className="flex-shrink-0" /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Payment link · {link.username}.arc</span>
        </div>
        <div style={{ position: 'relative', fontSize: 22, fontWeight: 800, letterSpacing: '-0.4px', lineHeight: 1.1, marginTop: 3 }}>
          {link.amount ? <>${formatAmount(Number(link.amount))} <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.85 }}>USDC</span></> : 'Any amount'}
        </div>
      </div>
      <div style={{ padding: '10px 13px 12px' }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {own ? 'Your payment link' : `Pay ${link.username}.arc on MeshPort`}
        </div>
        {!isMine && !own && (
          <button onClick={pay}
            style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 10, border: 'none', background: 'var(--text-primary)', color: 'var(--surface)', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
            {link.amount ? `Pay now · $${formatAmount(Number(link.amount))}` : 'Pay now'}
          </button>
        )}
      </div>
    </div>
  )
}
