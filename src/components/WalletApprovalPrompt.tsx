// The shared passcode sheet for an action the wallet frame refused for want
// of a recent passcode (lib/walletApproval). Checked by the frame itself.

import { useState } from 'react'
import { PinSheet } from '@/components/ui/PinSheet'
import { useApprovalPrompt, approveWallet } from '@/lib/walletApproval'

export function WalletApprovalPrompt() {
  const { open, resolve } = useApprovalPrompt()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  if (!open && !pin && !error) return null

  const close = (ok: boolean) => { setPin(''); setError(''); setChecking(false); resolve?.(ok) }
  const submit = async (value: string) => {
    if (checking) return
    setChecking(true)
    const r = await approveWallet(value)
    setChecking(false)
    if (r.ok) { close(true); return }
    setPin('')
    setError(r.error === 'rate-limited'
      ? `Too many tries - wait ${Math.ceil((r.lockedForMs ?? 30_000) / 1000)} s`
      : r.error === 'bad-passcode' ? 'Wrong passcode' : "Couldn't check the passcode - try again")
  }

  return (
    <PinSheet
      open={open}
      id="wallet-approve"
      zIndex={400}
      title="Approve with passcode"
      subtitle="Enter your passcode to approve this"
      bioVerb="Confirm"
      value={pin}
      onChange={v => { setPin(v); setError('') }}
      error={error || undefined}
      footer={checking ? 'Checking…' : undefined}
      locked={checking}
      onClose={() => close(false)}
      onComplete={value => { void submit(value) }}
    />
  )
}
