// Chat + → Request (USDC only): ask this person for an amount, with an
// optional note. Creates a real payment request (an order) and posts it as
// the live 💸 Payment request card - they pay it right in the chat, and it
// turns Paid for them and Payment received for you.
// Same layout as the chat's Pay sheet: person, amount box, quick amounts,
// keypad (phone), Cancel / Request. Typing the note hides the keypad, so
// the amount, note and button stay above the phone keyboard.
import { useEffect, useRef, useState } from 'react'
import { TokenLogo } from '@/components/ui/TokenLogo'
import { amountFontSize } from '@/lib/amountFontSize'
import { formatAmount } from '@/lib/utils'
import { ChatSheet, SheetPerson } from './ChatSheet'

const MAX_REQUEST = 1_000_000 // the database's limit for one request
const QUICK = ['5', '10', '20', '50']
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del']

/** Typed amount → at most 6 decimals (USDC), one dot, no leading zeros. */
export function cleanRequestAmount(raw: string): string {
  let v = raw.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,6}).*$/, '$1')
  if (v.startsWith('.')) v = '0' + v
  v = v.replace(/^0+(?=\d)/, '')
  return v
}

export function ChatRequestSheet({ open, onClose, isDesktop, name, username, avatar, onRequest }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  name: string
  username: string
  avatar?: string | null
  /** Creates the request and posts it; throws with a message to show. */
  onRequest: (amount: number, note: string) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [typingNote, setTypingNote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const noteRef = useRef<HTMLInputElement>(null)

  // A fresh sheet every time it opens.
  useEffect(() => { if (open) { setAmount(''); setNote(''); setError(''); setBusy(false); setTypingNote(false) } }, [open])

  const n = parseFloat(amount) || 0
  const tooBig = n > MAX_REQUEST
  const valid = n > 0 && !tooBig
  // The button repeats exactly what was typed ("12.50" stays "12.50").
  const amtLabel = amount.replace(/\.$/, '')
  const set = (v: string) => { setAmount(cleanRequestAmount(v)); setError('') }

  const press = (key: string) => {
    if (key === 'del') { set(amount.slice(0, -1)); return }
    if (key === '.' && amount.includes('.')) return
    set(amount + key)
  }

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      await onRequest(n, note.trim())
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the request')
    } finally { setBusy(false) }
  }

  const compact = !isDesktop && typingNote
  const amountBox = (
    <div className="rounded-2xl flex items-center justify-between gap-3"
      style={{ background: 'var(--bg)', border: '1px solid var(--border)', padding: compact ? '10px 14px' : '14px 16px' }}>
      <div className="min-w-0 flex-1">
        {isDesktop ? (
          <div className="flex items-baseline">
            <span style={{ fontSize: 36, fontWeight: 800, color: amount ? 'var(--text-primary)' : 'var(--text-muted)' }}>$</span>
            <input autoFocus inputMode="decimal" value={amount} placeholder="0" aria-label="Amount to request in USDC"
              onChange={e => set(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit() }}
              className="flex-1 min-w-0 bg-transparent outline-none text-text-primary"
              style={{ border: 'none', fontSize: 36, fontWeight: 800, letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums' }} />
          </div>
        ) : (
          <div aria-label="Amount to request in USDC" className="flex items-baseline" style={{ fontSize: compact ? 28 : amountFontSize(amount, 38), fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1.05 }}>
            <span style={{ color: amount ? 'var(--text-primary)' : 'var(--text-muted)' }}>$</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: amount ? 'var(--text-primary)' : 'var(--text-muted)' }}>{amount || '0'}</span>
          </div>
        )}
        {!compact && (
          <p className="text-[12.5px] mt-1" style={{ color: tooBig ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: tooBig ? 600 : 500 }}>
            {tooBig ? `Up to $${formatAmount(MAX_REQUEST)} per request` : 'They pay it right here in chat'}
          </p>
        )}
      </div>
      <span className="flex items-center gap-2 flex-shrink-0 rounded-full pl-1.5 pr-3 py-1.5"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <TokenLogo token="USDC" size={22} />
        <span className="text-[14px] font-bold text-text-primary">USDC</span>
      </span>
    </div>
  )

  return (
    <ChatSheet open={open} onClose={onClose} isDesktop={isDesktop} id="chat-request">
      <div className="px-5 pb-5 flex flex-col gap-3 overflow-y-auto" style={{ paddingTop: isDesktop ? 20 : 6, paddingBottom: compact ? 12 : 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
        <SheetPerson label="Request from" name={name} username={username} avatar={avatar} compact={compact} onClose={isDesktop ? onClose : undefined} />
        {amountBox}

        <input ref={noteRef} value={note} maxLength={140} placeholder="What's it for? (optional)" aria-label="Note for the request"
          onChange={e => setNote(e.target.value)}
          onFocus={() => setTypingNote(true)} onBlur={() => setTypingNote(false)}
          onKeyDown={e => { if (e.key === 'Enter') noteRef.current?.blur() }}
          enterKeyHint="done"
          className="w-full rounded-[14px] px-3.5 py-3 text-[14.5px] text-text-primary outline-none placeholder:text-text-muted"
          style={{ background: 'var(--bg)', border: `1px solid ${typingNote ? 'var(--brand-text)' : 'var(--border)'}` }} />

        {!compact && (
          <div className="grid grid-cols-4 gap-2">
            {QUICK.map(v => {
              const on = amount === v
              return (
                <button key={v} type="button" onClick={() => set(v)}
                  className="rounded-full text-[13.5px] font-bold active:scale-95 transition-transform"
                  style={{ height: 36, border: `1px solid ${on ? 'var(--brand-text)' : 'var(--border)'}`,
                    background: on ? 'color-mix(in srgb, var(--brand) 18%, transparent)' : 'transparent',
                    color: on ? 'var(--brand-text)' : 'var(--text-secondary)' }}>
                  ${v}
                </button>
              )
            })}
          </div>
        )}

        {!isDesktop && !compact && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, width: '100%', maxWidth: 320, margin: '2px auto 0' }}>
            {KEYS.map(key => (
              <button key={key} type="button" onClick={() => press(key)} aria-label={key === 'del' ? 'Delete' : key}
                style={{ height: 52, borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  fontSize: key === '.' ? 28 : 24, fontWeight: 600, color: key === 'del' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                {key === 'del'
                  ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" /><line x1="18" y1="9" x2="12" y2="15" /><line x1="12" y1="9" x2="18" y2="15" /></svg>
                  : key}
              </button>
            ))}
          </div>
        )}

        {error && <p role="alert" className="text-sm text-danger text-center">{error}</p>}

        <div className="flex gap-3 pt-1">
          {!compact && (
            <button type="button" onClick={onClose}
              className="py-3.5 rounded-2xl text-[15px] font-semibold active:scale-95 transition-transform"
              style={{ flex: 0.8, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)', color: 'var(--text-secondary)' }}>
              Cancel
            </button>
          )}
          <button type="button" onClick={submit} disabled={!valid || busy}
            // Keep the keyboard up while tapping the button (the note blur
            // would otherwise move it before the tap lands).
            onMouseDown={e => e.preventDefault()}
            className="flex-1 py-3.5 rounded-2xl text-[15px] font-bold text-white disabled:opacity-40 active:scale-95 transition-transform"
            style={{ background: 'var(--brand)' }}>
            {busy ? 'Requesting…' : valid ? `Request $${amtLabel}` : 'Request'}
          </button>
        </div>
      </div>
    </ChatSheet>
  )
}
