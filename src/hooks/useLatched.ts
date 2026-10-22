import { useRef } from 'react'

/**
 * The last non-empty value. A popup opened from `x` (`open={!!x}`) and drawn
 * from it keeps showing what it showed while it animates closed - reading
 * `x` itself, it would go blank (or change title) the moment `x` is cleared,
 * which flashes as it leaves.
 */
export function useLatched<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(value ?? null)
  if (value != null) last.current = value
  return last.current
}
