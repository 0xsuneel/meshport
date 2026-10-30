// Home: payments sent but queued on Arc behind a missing nonce (lib/stuckPayments).
// They would all run the moment that nonce is used - the person chooses to
// cancel them here instead. Checked once per wallet per session.

import { getReadySigner } from '@/lib/paymentReadiness'
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store'
import type { StuckPayments, CancelOutcome } from '@/lib/stuckPayments'

const checked = new Map<string, StuckPayments | null>()

export function StuckPaymentsBanner() {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const signer = useAuthStore(s => s.signer)
  const key = walletAddress?.toLowerCase() ?? ''
  const [stuck, setStuck] = useState<StuckPayments | null>(() => checked.get(key) ?? null)
  const [confirming, setConfirming] = useState(false)
  const [step, setStep] = useState('')
  const [result, setResult] = useState<Record<number, CancelOutcome> | null>(null)

  useEffect(() => {
    if (!key || !signer || checked.has(key)) return
    checked.set(key, null)
    void import('@/lib/stuckPayments').then(m => m.fetchStuckPayments()).then(s => {
      checked.set(key, s)
      setStuck(s)
    })
  }, [key, signer])

  if (!stuck?.stuck.length && !result) return null
  const n = stuck?.stuck.length ?? 0

  const cancel = async () => {
    if (!signer || !stuck) return
    setConfirming(false)
    setStep('Signing')
    try {
      const ready = await getReadySigner()
      if (!ready) throw new Error('wallet not open')
      const { cancelStuckPayments } = await import('@/lib/stuckPayments')
      const out = await cancelStuckPayments(ready, stuck, setStep)
      setResult(out)
      checked.set(key, null)
      setStuck(null)
    } catch (e) {
      setStep('')
      setResult({ [-1]: 'unknown' })
      console.warn('[stuck payments] cancel failed:', e)
    }
  }

  const tone = 'var(--warning)'
  let title = `${n} payment${n === 1 ? ' is' : 's are'} stuck on Arc`
  let text = "They were sent but are waiting behind an earlier one that never went out. They'll go through on your next payment unless you cancel them. Cancelling costs only network fees."
  if (result) {
    const vals = Object.values(result)
    const cancelled = vals.filter(v => v === 'cancelled').length
    const ran = vals.filter(v => v === 'ran').length
    title = cancelled === vals.length ? 'Stuck payments cancelled' : 'Cancel finished - check Activity'
    text = [
      cancelled ? `${cancelled} cancelled - no money left your wallet for ${cancelled === 1 ? 'it' : 'them'}.` : '',
      ran ? `${ran} went through before ${ran === 1 ? 'it' : 'they'} could be cancelled.` : '',
      vals.length - cancelled - ran ? "Some couldn't be confirmed yet - check Activity in a minute." : '',
    ].filter(Boolean).join(' ')
  }

  return (
    <div style={{ margin: '12px 0 0', padding: 16, borderRadius: 16,
      background: `color-mix(in srgb, ${tone} 8%, var(--card))`, border: `1px solid color-mix(in srgb, ${tone} 28%, var(--border))` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: tone, flexShrink: 0 }} />
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>{text}</div>
      {!result && (
        <button type="button" disabled={!!step} onClick={() => (confirming ? void cancel() : setConfirming(true))}
          style={{ marginTop: 12, minHeight: 40, padding: '0 16px', borderRadius: 12, border: 'none', background: confirming ? 'var(--danger)' : 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: step ? 'default' : 'pointer', opacity: step ? 0.7 : 1 }}>
          {step ? `${step}…` : confirming ? `Yes, cancel ${n === 1 ? 'it' : `all ${n}`}` : `Cancel ${n === 1 ? 'it' : 'them'}`}
        </button>
      )}
    </div>
  )
}
