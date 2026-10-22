// Direction of an in-page step change (Pay's amount → review, a wizard's
// step 2 → 1, …), so steps slide like pages: forward from the right, back
// from the left (ScreenPush's `back`). `order` lists the steps front to back.
import { useRef } from 'react'
import { type NavDirection } from '@/lib/motion'

export function useStepDirection<T>(step: T, order: readonly T[]): NavDirection {
  const prev = useRef(step)
  const dir = useRef<NavDirection>('forward')
  if (prev.current !== step) {
    const a = order.indexOf(prev.current), b = order.indexOf(step)
    dir.current = a >= 0 && b >= 0 && b < a ? 'back' : 'forward'
    prev.current = step
  }
  return dir.current
}
