// "Pay on Solana" - a MeshPort request, bill or pay link paid from a Solana
// wallet (Phantom, Solflare, Backpack…) with Solana Pay (lib/solanaPay.ts):
// a QR to scan, or "Open in wallet" on a phone, with the address, exact
// amount and USDC filled in. For an order the transfer carries the order's
// reference, so this page sees the payment land and merchant-pay confirms it
// (its watcher finds it too, if this page is closed).
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useUIStore } from '@/store'
import { formatAmount, copyToClipboard } from '@/lib/utils'
import { drawMeshportQr } from '@/lib/qrLogo'
import { SOLANA_USDC_MINT, solanaExplorerUrl } from '@/lib/solana'
import { findSolanaPayment, solanaPayUri, solanaReference } from '@/lib/solanaPay'
import { submitPayment } from '@/lib/merchantPay'

type Props = {
  /** Recipient's Solana address. */
  to: string
  /** Fixed amount (orders / requests); null → the payer's wallet asks. */
  amount: number | null
  /** Order code: the transfer names the order and is confirmed against it. */
  code?: string
  orderNumber?: string | null
  /** Shown in the wallet ("Pay <label>"). */
  label?: string
  onPaid?: () => void
}

export function SolanaPayPanel({ to, amount, code, orderNumber, label, onPaid }: Props) {
  const { showToastMessage } = useUIStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [reference, setReference] = useState<string | null>(null)
  const [step, setStep] = useState<'waiting' | 'confirming' | 'done'>('waiting')
  const [sig, setSig] = useState('')

  useEffect(() => { if (code) solanaReference(code).then(setReference).catch(() => setReference(null)) }, [code])
  const uri = code && !reference ? '' : solanaPayUri({
    to, amount: amount ?? undefined, reference: reference ?? undefined,
    label: label ?? 'MeshPort', message: orderNumber ? `Order ${orderNumber}` : undefined,
  })

  useEffect(() => {
    if (!uri || !canvasRef.current) return
    drawMeshportQr(canvasRef.current, uri, 220).catch(() => {})
  }, [uri])

  // An order: watch for the transfer that names it, then confirm it.
  useEffect(() => {
    if (!code || !reference || step === 'done') return
    let stop = false
    const tick = async () => {
      if (stop || step !== 'waiting') return
      const s = await findSolanaPayment(reference).catch(() => null)
      if (!s || stop) return
      setSig(s); setStep('confirming')
      await submitPayment(code, 'Solana_Devnet', s, amount != null ? { amount } : {}).catch(() => null)
      if (stop) return
      setStep('done'); onPaid?.()
    }
    const iv = setInterval(() => { void tick() }, 4000)
    void tick()
    return () => { stop = true; clearInterval(iv) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, reference, step])

  const copy = async (v: string, what: string) => {
    const ok = await copyToClipboard(v)
    showToastMessage(ok ? `${what} copied` : 'Could not copy', ok ? 'success' : 'error')
  }
  const row = (k: string, v: string, copyVal?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ color: 'var(--text-secondary)', width: 64, flexShrink: 0 }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
      {copyVal && (
        <button type="button" onClick={() => copy(copyVal, k)} aria-label={`Copy ${k}`}
          style={{ flexShrink: 0, background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex' }}><Copy size={13} /></button>
      )}
    </div>
  )

  if (step === 'done') {
    return (
      <div className="bg-surface border border-border rounded-3xl p-5 flex flex-col items-center gap-2 text-center">
        <CheckCircle2 className="w-10 h-10" style={{ color: 'var(--success-text)' }} />
        <p className="text-base font-bold text-text-primary">Paid on Solana</p>
        {sig && <a href={solanaExplorerUrl('tx', sig)} target="_blank" rel="noopener noreferrer" className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--brand-text)' }}>View on Solana Explorer <ExternalLink className="w-3 h-3" /></a>}
      </div>
    )
  }

  return (
    <div className="bg-surface soft-card rounded-3xl p-4 flex flex-col items-center gap-3">
      <p className="text-sm font-semibold text-text-primary">Pay with a Solana wallet</p>
      <div style={{ background: '#fff', borderRadius: 16, padding: 10 }}>
        <canvas ref={canvasRef} width={220} height={220} style={{ display: 'block', width: 220, height: 220 }} />
      </div>
      <p className="text-[12px] text-text-secondary text-center leading-snug">
        Scan with Phantom, Solflare or Backpack - it opens the payment with the address and {amount != null ? 'exact amount' : 'USDC'} filled in.
      </p>
      {uri && (
        <a href={uri} className="w-full text-center text-white font-bold rounded-2xl py-3" style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
          Open in Solana wallet
        </a>
      )}
      <div className="w-full flex flex-col gap-1.5 rounded-xl p-3" style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)' }}>
        {row('Network', 'Solana Devnet')}
        {row('Token', `USDC · ${SOLANA_USDC_MINT.slice(0, 6)}…${SOLANA_USDC_MINT.slice(-4)}`, SOLANA_USDC_MINT)}
        {row('To', `${to.slice(0, 8)}…${to.slice(-6)}`, to)}
        {amount != null && row('Amount', `${formatAmount(amount)} USDC (exact)`, String(amount))}
      </div>
      {code && (
        <p className="text-[12px] text-text-secondary text-center inline-flex items-center gap-1.5">
          {step === 'confirming' ? <><Loader2 className="w-3 h-3 animate-spin" /> Payment seen - confirming…</> : <><Loader2 className="w-3 h-3 animate-spin" /> Waiting for the payment…</>}
        </p>
      )}
      {code && (
        <p className="text-[11px] text-text-muted text-center leading-snug">
          Pay from the QR or the button so the payment is linked to this order. A plain send to the address can still be matched by {label ?? 'the business'}.
        </p>
      )}
    </div>
  )
}
