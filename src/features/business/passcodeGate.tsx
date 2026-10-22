// Passcode gate for Business money moves (same check as Settle and Refund):
// ask() runs the action at once when no passcode is set, else after the
// right one is typed into the app's passcode step (PinSheet). A wrong code
// clears the digits and shows the error under the title.
import { useState } from 'react'
import { useAuthStore } from '@/store'
import { PinSheet } from '@/components/ui/PinSheet'

export function usePasscodeGate() {
  const hash = useAuthStore(s => s.passcode)
  const [pending, setPending] = useState<{ title: string; subtitle: string; run: (code?: string) => void } | null>(null)
  const [error, setError] = useState<string>()
  const [value, setValue] = useState('')
  const ask = (title: string, subtitle: string, run: (code?: string) => void) => { if (!hash) { run(); return } setError(undefined); setValue(''); setPending({ title, subtitle, run }) }
  const sheet = (
    <PinSheet open={!!pending} title={pending?.title ?? ''} subtitle={pending?.subtitle ?? ''} error={error}
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
