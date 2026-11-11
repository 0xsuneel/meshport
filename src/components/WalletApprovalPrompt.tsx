// The shared approval sheet for an action the wallet frame refused for want
// of a recent approval (lib/walletApproval). The approval is given on the
// wallet's own page inside this sheet (PinSheet walletConfirm): a passcode
// typed into the app's keypad never approves anything.

import { useState } from 'react'
import { PinSheet } from '@/components/ui/PinSheet'
import { useApprovalPrompt, checkWalletPasscode } from '@/lib/walletApproval'
import { isWalletConfirmToken, walletConfirmTokenValid } from '@/lib/walletConfirmToken'
import { walletConfirmAddress } from '@/lib/walletConfirm'

export function WalletApprovalPrompt() {
  const { open, resolve } = useApprovalPrompt()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  // A new sheet (and a new try in the wallet's page) after the keypad set up a passcode.
  const [round, setRound] = useState(0)
  if (!open && !pin && !error) return null

  const close = (ok: boolean) => { setPin(''); setError(''); setChecking(false); resolve?.(ok) }
  const submit = async (value: string) => {
    if (checking) return
    // Approved on the wallet's own page.
    if (isWalletConfirmToken(value)) { if (walletConfirmTokenValid(value)) close(true); else { setPin(''); setError('Try again') } return }
    // The keypad only shows when the wallet's page couldn't (no passcode on
    // this device yet, or an older wallet): check it - which sets the
    // device's passcode - then approve on the wallet's page.
    setChecking(true)
    const r = await checkWalletPasscode(value)
    setChecking(false)
    setPin('')
    if (r.ok) {
      if (walletConfirmAddress()) { setError(''); setRound(n => n + 1) }
      else setError('Your wallet needs an update - reload MeshPort and try again')
      return
    }
    setError(r.error === 'rate-limited'
      ? `Too many tries - wait ${Math.ceil((r.lockedForMs ?? 30_000) / 1000)} s`
      : r.error === 'bad-passcode' ? 'Wrong passcode' : "Couldn't check the passcode - try again")
  }

  return (
    <PinSheet walletConfirm key={round}
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
