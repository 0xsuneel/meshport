import { motion } from 'framer-motion'
import { DIALOG_BACKDROP } from '@/lib/motion'

// The dim behind a centred popup, as its own layer. Only the dim fades: when
// the whole overlay (dim + card) faded in together, the card was see-through
// for its first frames and the page showed through it. Invisible on dark
// pages, but on light pages the text underneath flickered inside the white
// card. Put it first inside the fixed overlay, and give the card
// `position: relative` so it sits above it.
export function PopupDim({ background = 'rgba(6,10,14,0.62)' }: { background?: string }) {
  return (
    <motion.div aria-hidden
      initial={DIALOG_BACKDROP.initial} animate={DIALOG_BACKDROP.animate} exit={DIALOG_BACKDROP.exit}
      transition={DIALOG_BACKDROP.transition}
      style={{ position: 'absolute', inset: 0, background }} />
  )
}
