// The one helper every push / slide uses to move an element on the browser's
// own animation engine (Web Animations, on the compositor) - PushLayer and
// HubPage. Not framer-motion's `x`: that is stepped from JavaScript every
// frame, so a page that loads or renders while it slides in (a fee fetch,
// a big list) stalls those frames and the slide jumps / flickers.
import { PUSH_EASE_CSS } from '@/lib/motion'

/** Animates one property of `el` from where it is now to `to` (and leaves it
 *  there). Interrupting a running move starts from the current spot. */
export function move(el: HTMLElement, prop: 'transform' | 'opacity', to: string, ms: number, from?: string): Animation | null {
  const now = from ?? getComputedStyle(el)[prop]
  el.getAnimations().forEach(a => a.cancel())
  el.style[prop] = to
  if (ms <= 0 || now === to) return null
  return el.animate([{ [prop]: now }, { [prop]: to }], { duration: ms, easing: PUSH_EASE_CSS })
}
