// src/lib/pressable.ts
//
// For a row or card that's tappable but laid out as a <div> (a whole list
// row, a tile): makes it a button to everything that isn't a finger - a
// screen reader announces it as one, Tab reaches it, Enter / Space press it.
// A plain <button> is better wherever its layout allows; use this where
// swapping the element would break the row's layout.
import type { KeyboardEvent, MouseEvent } from 'react'

export function pressable(onPress: (e?: MouseEvent<HTMLElement>) => void, label?: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    onClick: (e: MouseEvent<HTMLElement>) => onPress(e),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return // a control inside the row handles its own keys
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress() }
    },
  }
}
