import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Fingerprint, ScanFace } from 'lucide-react'
import { biometricLabel } from '@/lib/biometric'

// Manual-passcode payments keep the exact existing checkmark-only
// animation (this component, when `viaBiometric` is false, just renders
// that same static checkmark — no behavior change there at all). This
// component is also simply never mounted at all on the passcode path
// (both call sites only render it when the payment actually went via
// biometric), so the biometric icon can never appear anywhere for a
// passcode payment.
//
// Two different sequences share this component, picked by `loop`:
//
// - Flash (loop=false, the default) — the full-screen "Paid/Payment
//   Successful" moment right after processing. This is a single
//   confirmation blip, not a toggle: it starts ON the biometric icon
//   (fingerprint/Face ID) immediately, since the whole point is telling
//   the user *that's* what just confirmed the payment, holds it briefly,
//   then switches to the checkmark and stops there for good. It has to
//   end on the checkmark specifically — the traveling clone and the
//   landing spot on the success screen are both checkmark-shaped (see
//   TravelingCheckmark.tsx's own comment on why that shape has to match
//   exactly, or the handoff looks like two different icons instead of
//   one continuous one).
//
// - Landing (loop=true) — the success screen's own icon, mounted only
//   after the traveling checkmark clone has already landed there, so it
//   must start ON the checkmark (matching the clone's shape exactly, or
//   the handoff would visibly jump) and then keeps alternating
//   checkmark <-> biometric forever on a 2.5s cadence, since the success
//   screen just stays open until the user navigates away and the toggle
//   is meant to keep running the whole time it's visible.
//
// Same icon this payment's own PinKeypad biometric button already showed
// (biometricLabel() picks Face ID vs fingerprint by platform), so it's a
// familiar shape, not a new one introduced only here.
export function FlashAuthIcon({ viaBiometric, size, color, loop = false, start = true }: { viaBiometric: boolean; size: number; color: string; loop?: boolean; start?: boolean }) {
  const BioIcon = biometricLabel() === 'Face ID' ? ScanFace : Fingerprint
  // Flash (loop=false): step 0 = bio (shown right at mount), step 1 = check
  // (final, settled) — one transition, then the effect below stops itself.
  // Landing (loop=true): step 0 = check (matches the incoming traveling
  // checkmark), step 1 = bio, step 2 = check, ... continuing forever.
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!viaBiometric) return
    if (!loop && step >= 1) return
    // `start` (flash only — the caller's landing/loop usage never passes
    // this, so it's always true there) holds the timer off entirely until
    // the caller says the surrounding circle has actually finished
    // animating into view. Guessing a fixed millisecond hold here instead
    // was fragile: this component's own timer starts at ITS mount, which
    // is the same instant as the circle's, not when the circle actually
    // becomes visible — so a fixed hold could still elapse (swapping to
    // the checkmark, or on some devices/renders skipping the bio icon
    // rendering step entirely if this re-runs before the circle paints)
    // while the circle was still fading/scaling in, or before it had
    // painted at all. Waiting for the caller's real "done animating"
    // signal removes that guesswork and the bio icon is now guaranteed to
    // get an on-screen frame before it swaps.
    if (!start) return
    // Landing loop: 2.5s hold on each icon before crossfading to the other.
    // Sequence stays: land as checkmark (matches the incoming traveling
    // clone exactly, sits there untouched for this full 2.5s) -> THEN the
    // very first move is to the biometric symbol -> 2.5s hold -> back to
    // checkmark -> ... alternating forever. It never moves check->check
    // or repeats the same icon twice in a row — showingBio below flips on
    // every step, so landing on checkmark always resolves to the next
    // step being biometric, never another checkmark.
    const t = setTimeout(() => setStep(s => s + 1), loop ? 2500 : 260)
    return () => clearTimeout(t)
  }, [viaBiometric, loop, start, step])

  const showingBio = viaBiometric && (loop ? step % 2 === 1 : step === 0)

  // Landing's crossfade is slower and eased (0.5s, easeInOut) instead of
  // the flash's snappy 0.18s linear-ish fade — smoother/softer to match a
  // 3s-paced loop instead of looking like a flicker between long holds.
  const transition = loop ? { duration: 0.5, ease: 'easeInOut' } : { duration: 0.18 }

  return (
    <AnimatePresence mode="wait">
      {showingBio ? (
        <motion.div key="bio" initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={transition}>
          <BioIcon width={size} height={size} style={{ color }} />
        </motion.div>
      ) : (
        <motion.svg key="check" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"
          initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={transition}>
          <polyline points="20 6 9 17 4 12" />
        </motion.svg>
      )}
    </AnimatePresence>
  )
}
