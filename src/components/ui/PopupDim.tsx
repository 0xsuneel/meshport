import { motion } from 'framer-motion'
import { DIALOG_BACKDROP, POPUP_DIM } from '@/lib/motion'

// The dim behind a centred popup, as its own layer. Only the dim fades: when
// the whole overlay (dim + card) faded in together, the card was see-through
// for its first frames and the page showed through it. Invisible on dark
// pages, but on light pages the text underneath flickered inside the white
// card. Put it first inside the fixed overlay, and give the card
// `position: relative` so it sits above it.
// `leave` variant: inside an AnimatePresence whose `custom` is true (its popup
// is leaving under a page that replaces it), the dim goes at once.
export function PopupDim({ background = POPUP_DIM }: { background?: string }) {
  return (
    <motion.div aria-hidden
      initial={DIALOG_BACKDROP.initial} animate={DIALOG_BACKDROP.animate}
      variants={{ leave: (instant?: boolean) => instant ? { opacity: 0, transition: { duration: 0 } } : DIALOG_BACKDROP.exit }} exit="leave"
      transition={DIALOG_BACKDROP.transition}
      style={{ position: 'absolute', inset: 0, background }} />
  )
}
