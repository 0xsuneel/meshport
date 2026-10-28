import type { ComponentType } from 'react'
import { biometricAction, biometricWaiting, type BiometricVerb } from '@/lib/biometricWording'

// What a passcode screen shows first when fingerprint / Face ID is turned
// on: one solid biometric button (the OS prompt opens by itself on top of
// it) and a way to type the passcode instead. If the prompt is cancelled it
// stays here: "Unlock with Face ID" / "Pay with fingerprint" to try again,
// or "Use passcode". Used by PinKeypad (every approval) and the lock screen.
// `height` matches the number pad it stands in for, so switching to the pad
// never resizes the sheet.
export function BiometricFirst({ Icon, label, verb, trying, onTry, onUsePasscode, height, status }: {
  Icon: ComponentType<{ className?: string }>
  label: string
  verb: BiometricVerb
  trying: boolean
  onTry: () => void
  onUsePasscode: () => void
  height: number
  /** Shown instead of "Waiting for Face ID…" while busy after it (the lock screen opening the wallet). */
  status?: string
}) {
  const action = biometricAction(verb, label)
  return (
    <div style={{ height, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      {/* Plain button: WebKit wants the WebAuthn call inside a raw click. */}
      <button onClick={onTry} disabled={trying} aria-label={action}
        style={{
          position: 'relative', width: 84, height: 84, borderRadius: '50%', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--brand)', border: 'none', color: '#fff',
          boxShadow: '0 12px 26px -12px color-mix(in srgb, var(--brand) 85%, transparent)',
        }}>
        <span aria-hidden style={{ position: 'absolute', inset: -12, borderRadius: '50%', border: '1.5px solid color-mix(in srgb, var(--brand) 25%, transparent)' }} />
        <Icon className="w-10 h-10" />
      </button>
      <button onClick={onTry} disabled={trying}
        style={{ marginTop: 22, padding: '4px 10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
        {status ?? (trying ? biometricWaiting(label) : action)}
      </button>
      <button onClick={onUsePasscode} className="active:scale-[0.98] transition-transform"
        style={{ marginTop: 26, width: '100%', maxWidth: 320, height: 50, borderRadius: 14, cursor: 'pointer', background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
        Use passcode
      </button>
    </div>
  )
}
