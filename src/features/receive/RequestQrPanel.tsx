// Receive → MeshPort QR → "Request payment" (every user).
// Amount + expiry (+ customer and note for merchants) → a payment request with a
// unique order number. The QR, the copied link and the shared link all carry
// the order: /paylink/r/<code>?order=ORD-…  Scanned in MeshPort (or opened), the
// payer's amount and order number are fixed - they can't be edited.
// The QR is the order link: MeshPort's scanner opens the order; a wallet
// app's scanner (MetaMask, OKX, Trust, Coinbase…) opens it in the wallet's
// browser, which adds Arc Testnet and fills in address, amount and network.
// (Merchants' other networks are on the Merchant QR tab.)
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Clock, Download, Share2, Copy, MessageCircle, Plus, X } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { formatAmount, copyToClipboard } from '@/lib/utils'
import {
  createPaymentRequest, watchPayment, orderLabel, orderPayLink, paymentRequestMessage, cancelPayment, expiryText, STATUS_LABEL,
  type MerchantIntent, type PaymentView,
} from '@/lib/merchantPay'
import { AmountHero } from '@/components/ui/AmountHero'
import { arcExplorerTxUrl } from '@/lib/chainExplorers'

const EXPIRY = [{ label: '15 min', min: 15 }, { label: '1 hour', min: 60 }, { label: '24 hours', min: 1440 }, { label: 'No expiry', min: 0 }]
const box: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow-1)' }
const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '11px 13px', borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 14, outline: 'none' }
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }
const ghost: React.CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 8px', borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primary: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '13px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }

export function ExpiryChips({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {EXPIRY.map(x => (
        <button key={x.min} type="button" onClick={() => onChange(x.min)}
          style={{ padding: '6px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border)',
            background: value === x.min ? 'var(--brand)' : 'transparent', color: value === x.min ? '#fff' : 'var(--text-secondary)' }}>{x.label}</button>
      ))}
    </div>
  )
}

export function RequestQrPanel({ withCustomer, initialCustomer, onClose, initialOrder, onNewRequest }: {
  withCustomer?: boolean; initialCustomer?: string; onClose?: () => void
  /** Open straight on an existing request (Receive → My requests). */
  initialOrder?: MerchantIntent
  /** "New request" replaces the default (clear and show the form here). */
  onNewRequest?: () => void
}) {
  const navigate = useNavigate()
  const { showToastMessage } = useUIStore()
  const user = useAuthStore(s => s.user)
  const [amount, setAmount] = useState('')
  const [customer, setCustomer] = useState(() => initialCustomer ? initialCustomer.replace(/\.arc$/i, '') + '.arc' : '')
  const [note, setNote] = useState('')
  const [expiry, setExpiry] = useState(60)
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<MerchantIntent | null>(initialOrder ?? null)
  // Customer (merchants, optional): looked up only when the FULL name is typed
  // ("sunil.arc") - exact match, no partial suggestions.
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [match, setMatch] = useState<{ state: 'idle' | 'checking' | 'found' | 'notfound' | 'self'; user?: { id: string; username: string; display_name?: string | null; avatar_url?: string | null } }>({ state: 'idle' })
  useEffect(() => {
    const raw = customer.trim().replace(/^@/, '').toLowerCase()
    if (!/^[a-z0-9_.-]+\.arc$/.test(raw)) { setMatch({ state: 'idle' }); return }
    setMatch({ state: 'checking' })
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const { getUserByUsername } = await import('@/lib/supabase')
        const u: any = await getUserByUsername(raw)
        if (cancelled) return
        if (!u?.id) setMatch({ state: 'notfound' })
        else if (walletAddress && u.wallet_address?.toLowerCase() === walletAddress.toLowerCase()) setMatch({ state: 'self' })
        else setMatch({ state: 'found', user: { id: String(u.id), username: u.username, display_name: u.display_name, avatar_url: u.avatar_url } })
      } catch { if (!cancelled) setMatch({ state: 'notfound' }) }
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [customer, walletAddress])
  const [live, setLive] = useState<PaymentView | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const link = order ? orderPayLink(order.code, order.orderNumber) : ''
  const qrValue = !order ? '' : link

  useEffect(() => {
    if (!qrValue || !canvasRef.current) return
    import('qrcode').then(Q => Q.toCanvas(canvasRef.current!, qrValue, { width: 220, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'M' })).catch(() => {})
  }, [qrValue])
  useEffect(() => (order ? watchPayment(order.code, setLive, 5000) : undefined), [order?.code])

  const create = async () => {
    const n = Number(amount)
    if (!(n > 0)) { showToastMessage('Enter an amount', 'error'); return }
    setBusy(true)
    try {
      const typed = customer.trim()
      if (typed && match.state !== 'found') {
        showToastMessage(match.state === 'self' ? "You can't send a request to yourself"
          : 'Enter the full MeshPort username, like sunil.arc', 'error')
        setBusy(false); return
      }
      const who = match.state === 'found' && match.user ? match.user.username.replace(/\.arc$/i, '').toLowerCase() : ''
      const it = await createPaymentRequest({ amount: n, customer: who || undefined, note, expiresInMinutes: expiry || null })
      // With a username: the request goes straight into your chat with them
      // as a payment card (amount + order number fixed for them).
      if (who && match.user && user?.id) {
        const { ensureConversation } = await import('@/lib/chatService')
        const convId = await ensureConversation(String(user.id), match.user.id).catch(() => null)
        if (convId) {
          navigate(`/chat/${convId}`, { state: { autoSend: paymentRequestMessage(it, formatAmount(it.amount)) } })
          return
        }
        showToastMessage(`Order #${orderLabel(it)} created - couldn't open the chat`, 'error')
      }
      setLive(null); setOrder(it)
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not create the request', 'error')
    }
    setBusy(false)
  }

  const shareText = () => order
    ? `Pay $${formatAmount(order.amount)} USDC · Order #${orderLabel(order)}${order.note ? ` · ${order.note}` : ''}${expiryText(order.expiresAt) ? `\n${expiryText(order.expiresAt)}` : ''}\n${link}`
    : ''
  const qrFile = async (): Promise<File | null> => {
    const qr = canvasRef.current
    if (!qr || !order) return null
    const expires = expiryText(order.expiresAt)
    const W = 600, H = expires ? 776 : 740
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H
    const g = cv.getContext('2d'); if (!g) return null
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.textAlign = 'center'
    g.fillStyle = '#111'; g.font = '700 26px system-ui, sans-serif'; g.fillText('Pay with MeshPort', W / 2, 58)
    g.font = '800 44px system-ui, sans-serif'; g.fillText(`$${formatAmount(order.amount)} USDC`, W / 2, 118)
    g.fillStyle = '#444'; g.font = '600 22px system-ui, sans-serif'; g.fillText(`Order #${orderLabel(order)}`, W / 2, 156)
    g.drawImage(qr, (W - 420) / 2, 182, 420, 420)
    g.fillStyle = '#444'; g.font = '600 17px system-ui, sans-serif'
    g.fillText('Scan with MeshPort or any wallet app · Arc network', W / 2, 634)
    g.fillStyle = '#555'; g.font = '500 16px ui-monospace, monospace'
    g.fillText(link.length > 60 ? link.slice(0, 60) + '…' : link, W / 2, 666)
    if (expires) { g.fillStyle = '#B4531F'; g.font = '700 19px system-ui, sans-serif'; g.fillText(expires, W / 2, 708) }
    const blob: Blob | null = await new Promise(r => cv.toBlob(b => r(b), 'image/png'))
    return blob ? new File([blob], `request-${orderLabel(order)}.png`, { type: 'image/png' }) : null
  }
  const save = async () => {
    const f = await qrFile(); if (!f) return
    const url = URL.createObjectURL(f); const a = document.createElement('a'); a.href = url; a.download = f.name
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const share = async () => {
    if (!order) return
    const f = await qrFile().catch(() => null)
    try {
      if (f && navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: 'Payment request', text: shareText() }); return }
      if (navigator.share) { await navigator.share({ title: 'Payment request', text: shareText(), url: link }); return }
    } catch (e: any) { if (e?.name === 'AbortError') return }
    const ok = await copyToClipboard(shareText())
    showToastMessage(ok ? 'Link copied' : 'Could not copy', ok ? 'success' : 'error')
  }
  const sendInChat = async () => {
    if (!order?.customerUsername || !user?.id) return
    try {
      const [{ getUserByUsername }, { ensureConversation }] = await Promise.all([import('@/lib/supabase'), import('@/lib/chatService')])
      const other = await getUserByUsername(order.customerUsername)
      if (!other?.id) throw new Error(`${order.customerUsername}.arc isn't on MeshPort`)
      const convId = await ensureConversation(String(user.id), String(other.id))
      if (!convId) throw new Error('Could not open the chat')
      navigate(`/chat/${convId}`, { state: { autoSend: paymentRequestMessage(order, formatAmount(order.amount)) } })
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not open the chat', 'error')
    }
  }
  const cancel = async () => {
    if (!order) return
    try { setLive(await cancelPayment(order.code)) } catch (e) { showToastMessage(e instanceof Error ? e.message : 'Could not cancel', 'error') }
  }

  const header = (title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
      {onClose && (
        <button onClick={onClose} aria-label="Back to my QR" style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex' }}>
          <X size={18} />
        </button>
      )}
    </div>
  )

  if (order) {
    // Saved status until the live one loads (an old request opened from My requests).
    const saved = order.status === 'pending' && order.expiresAt && new Date(order.expiresAt).getTime() < Date.now() ? 'expired' : order.status
    const st = live?.status ?? saved ?? 'pending'
    const paid = st === 'paid'
    const closed = ['expired', 'cancelled', 'failed'].includes(st)
    const open = !paid && !closed
    const received = live?.received ?? order.received
    const payment = live?.payments.find(p => p.txHash) ?? null
    const paidAt = live?.paidAt ?? order.paidAt
    const payer = live?.customerUsername ?? order.customerUsername
    const when = (iso: string | null | undefined) => iso
      ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
    const txHref = payment?.txHash ? arcExplorerTxUrl(payment.txHash) : null
    const kv = (k: string, v: React.ReactNode, color?: string) => (
      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{k}</span>
        <span style={{ fontWeight: 600, color: color ?? 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{v}</span>
      </div>
    )
    return (
      <div style={{ ...box, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {header('Payment request')}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.4px' }}>
            ${formatAmount(order.amount)} <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>USDC</span>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)', marginTop: 2 }}>
            Order #{orderLabel(order)}{order.customerUsername ? ` · ${order.customerUsername}.arc` : ''}{order.note ? ` · ${order.note}` : ''}
          </div>
          {open && expiryText(order.expiresAt) && (
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginTop: 3 }}>{expiryText(order.expiresAt)}</div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ background: '#fff', padding: 6, borderRadius: 14, opacity: paid || closed ? 0.35 : 1 }}>
            <canvas ref={canvasRef} style={{ display: 'block', width: 220, height: 220 }} />
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
            color: paid ? 'var(--success)' : closed ? 'var(--text-secondary)' : 'var(--warning)',
            background: paid ? 'color-mix(in srgb, var(--success) 14%, transparent)' : closed ? 'color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'color-mix(in srgb, var(--warning) 14%, transparent)' }}>
            {paid ? <CheckCircle2 size={14} /> : <Clock size={14} />}
            {paid ? 'Payment received' : STATUS_LABEL[st]}
          </div>
          {open && (
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.45, maxWidth: 300 }}>
              Scan with MeshPort or any wallet app (MetaMask, OKX, Trust, Coinbase…) - the amount and order number are fixed; wallets get Arc, the address and the amount filled in.
            </div>
          )}
          {open && received > 0 && (
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>${formatAmount(received)} of ${formatAmount(order.amount)} received</div>
          )}
        </div>
        {/* Paid: who paid, how much, when, and the transaction. */}
        {paid && (
          <div>
            {kv('Paid by', payer ? `${payer.replace(/\.arc$/i, '')}.arc` : 'A wallet')}
            {kv('Received', `$${formatAmount(received || order.amount)} USDC`, 'var(--success)')}
            {when(paidAt) && kv('Paid on', when(paidAt))}
            {payment?.txHash && kv('Transaction', txHref
              ? <a href={txHref} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-text)', textDecoration: 'none' }}>{payment.txHash.slice(0, 6)}…{payment.txHash.slice(-4)} ↗</a>
              : `${payment.txHash.slice(0, 6)}…${payment.txHash.slice(-4)}`)}
            {when(order.createdAt) && kv('Created', when(order.createdAt))}
          </div>
        )}
        {closed && (
          <div>
            {kv('Status', st === 'expired' && order.expiresAt ? `Expired · ${when(order.expiresAt)}` : STATUS_LABEL[st], 'var(--text-secondary)')}
            {when(order.createdAt) && kv('Created', when(order.createdAt))}
          </div>
        )}
        {/* Sharing only while it can still be paid. */}
        {open && <>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all', textAlign: 'center', fontFamily: 'ui-monospace, monospace' }}>{link}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={ghost}><Download size={15} /> Save QR</button>
            <button onClick={share} style={ghost}><Share2 size={15} /> Share</button>
            <button onClick={async () => { const ok = await copyToClipboard(link); showToastMessage(ok ? 'Link copied' : 'Could not copy', ok ? 'success' : 'error') }} style={ghost}><Copy size={15} /> Copy link</button>
          </div>
        </>}
        {order.customerUsername && !paid && !closed && (
          <button onClick={sendInChat} style={{ ...ghost, flex: 'none' }}><MessageCircle size={15} /> Send to {order.customerUsername}.arc in chat</button>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {open && received === 0 && (
            <button onClick={cancel} style={{ ...ghost, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}>Cancel</button>
          )}
          {paid && (
            <button onClick={() => navigate('/activity')} style={ghost}>View in Activity</button>
          )}
          <button onClick={() => { if (onNewRequest) { onNewRequest(); return } setOrder(null); setLive(null); setAmount(''); setNote('') }} style={{ ...primary, flex: 2 }}><Plus size={16} /> New request</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ ...box, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {header('Request payment')}
      <AmountHero value={amount} onChange={setAmount} autoFocus />
      {/* Merchants only: their customer + note. Everyone else requests from a
          person in chat (+ → Request), so here it's just amount + expiry. */}
      {withCustomer && <div>
        <div style={label}>Customer (optional)</div>
        <input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="username.arc" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={field} />
        {match.state === 'found' && match.user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 10px', borderRadius: 12, background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)' }}>
            {match.user.avatar_url
              ? <img src={match.user.avatar_url} alt="" width={26} height={26} style={{ borderRadius: '50%', objectFit: 'cover' }} />
              : <span style={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--brand)', color: '#fff', fontSize: 12, fontWeight: 700 }}>{(match.user.display_name || match.user.username).slice(0, 1).toUpperCase()}</span>}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{match.user.display_name || match.user.username}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{match.user.username.replace(/\.arc$/i, '')}.arc · the request is sent to them in chat</div>
            </div>
            <CheckCircle2 size={16} color="var(--success)" />
          </div>
        )}
        {match.state === 'checking' && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>Checking…</div>}
        {match.state === 'notfound' && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>No MeshPort user with this username</div>}
        {match.state === 'self' && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>That's your own username</div>}
        {match.state === 'idle' && customer.trim() !== '' && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>Type the full username, like sunil.arc</div>}
      </div>}
      {withCustomer && <div><div style={label}>Note (optional)</div><input value={note} onChange={e => setNote(e.target.value)} maxLength={140} placeholder="e.g. Order details" style={field} /></div>}
      <div><div style={label}>Expires</div><ExpiryChips value={expiry} onChange={setExpiry} /></div>
      <button onClick={create} disabled={busy || !(Number(amount) > 0)} style={{ ...primary, opacity: busy || !(Number(amount) > 0) ? 0.5 : 1 }}>
        {busy ? 'Creating…' : match.state === 'found' ? 'Send request in chat' : 'Generate request QR'}
      </button>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center', marginTop: -4 }}>Every request gets a unique order number.</div>
    </div>
  )
}
