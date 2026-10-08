import type { ComponentType } from 'react'
import { motion } from 'framer-motion'

// What a passcode screen shows first when fingerprint / Face ID is turned
// on: one big biometric button (the OS prompt is already opening on top of
// it) and a way to type the passcode instead. Used by PinKeypad (every
// transaction approval) and the lock screen. `height` matches the number pad
// it stands in for, so switching to the pad never resizes the sheet.
export function BiometricFirst({ Icon, label, trying, onTry, onUsePasscode, height }: {
  Icon: ComponentType<{ className?: string }>
  label: string
  trying: boolean
  onTry: () => void
  onUsePasscode: () => void
  height: number
}) {
  const what = label === 'Face ID' ? 'Face ID' : label === 'Fingerprint' ? 'fingerprint' : 'biometrics'
  return (
    <div style={{ height, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      {/* Plain button: WebKit wants the WebAuthn call inside a raw click. */}
      <button onClick={onTry} disabled={trying} aria-label={`Use ${what}`}
        style={{
          position: 'relative', width: 96, height: 96, borderRadius: '50%', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'color-mix(in srgb, var(--brand) 14%, transparent)',
          border: '1.5px solid color-mix(in srgb, var(--brand-text) 35%, transparent)', color: 'var(--brand-text)',
        }}>
        {trying && (
          <motion.span aria-hidden initial={{ scale: 1, opacity: 0.55 }} animate={{ scale: 1.35, opacity: 0 }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }}
            style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid var(--brand-text)' }} />
        )}
        <Icon className="w-10 h-10" />
      </button>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
        {trying ? `Waiting for ${what}…` : `Tap to use ${what}`}
      </p>
      <button onClick={onUsePasscode}
        style={{ marginTop: 6, padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--brand-text)' }}>
        Use passcode
      </button>
    </div>
  )
}
