// Passcode gate for Business money moves (same check as Settle and Refund):
// ask() runs the action at once when no passcode is set, else after the
// right one is typed into the sheet.
import { useState } from 'react'
import { useAuthStore } from '@/store'
import { PasscodeSheet } from './ui'

export function usePasscodeGate() {
  const hash = useAuthStore(s => s.passcode)
  const [pending, setPending] = useState<{ title: string; subtitle: string; run: (code?: string) => void } | null>(null)
  const [error, setError] = useState<string>()
  const ask = (title: string, subtitle: string, run: (code?: string) => void) => { if (!hash) { run(); return } setError(undefined); setPending({ title, subtitle, run }) }
  const sheet = (
    <PasscodeSheet open={!!pending} title={pending?.title ?? ''} subtitle={pending?.subtitle ?? ''} error={error}
      onClose={() => setPending(null)}
      onComplete={async code => {
        const { verifyPasscode } = await import('@/lib/security')
        if (!hash || !await verifyPasscode(code, hash)) { setError('Incorrect passcode. Try again.'); return }
        const p = pending; setPending(null); p?.run(code)
      }} />
  )
  return { ask, sheet }
}
