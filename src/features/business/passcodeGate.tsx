// Passcode gate for Business money moves (same check as Settle and Refund):
// ask() runs the action at once when no passcode is set, else after the
// right one is typed into the app's passcode step (PinSheet). A wrong code
// clears the digits and shows the error under the title.
import { useLatched } from '@/hooks/useLatched'
import { useState } from 'react'
import { useAuthStore } from '@/store'
import { PinSheet } from '@/components/ui/PinSheet'
import type { ConfirmScope } from '@/wallet/protocol'

export function usePasscodeGate() {
  const hash = useAuthStore(s => s.passcode)
  const [pending, setPending] = useState<{ title: string; subtitle: string; run: (code?: string) => void; scope?: ConfirmScope | null } | null>(null)
  const [error, setError] = useState<string>()
  const [value, setValue] = useState('')
  /** `scope`: what the action may spend (lib/walletConfirm spendScope), for the wallet to hold it to. */
  const ask = (title: string, subtitle: string, run: (code?: string) => void, scope?: ConfirmScope | null) => { if (!hash) { run(); return } setError(undefined); setValue(''); setPending({ title, subtitle, run, scope }) }
  const shownPending = useLatched(pending)
  const sheet = (
    <PinSheet walletConfirm={{ scope: shownPending?.scope }} open={!!pending} title={shownPending?.title ?? ''} subtitle={shownPending?.subtitle ?? ''} error={error}
      value={value} onChange={v => { setValue(v); if (v) setError(undefined) }}
      onClose={() => setPending(null)}
      onComplete={async code => {
        const { verifyPasscode } = await import('@/lib/security')
        if (!hash || !await verifyPasscode(code, hash)) { setValue(''); setError('Incorrect passcode. Try again.'); return }
        const p = pending; setPending(null); p?.run(code)
      }} />
  )
  return { ask, sheet }
}
