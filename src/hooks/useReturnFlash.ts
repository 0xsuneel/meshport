import { useCallback, useState } from 'react'

// Rows opened before leaving for another page, per list (scope).
const leftFrom = new Map<string, string>()

/**
 * "This is the one you just opened": the row last opened flashes once
 * (className 'mp-last-opened', index.css) when you come back to the list -
 * same as Activity.
 *   • A row that opens a popup/sheet: call `opened()` when it opens and
 *     `closed(id)` when it closes.
 *   • A row that opens another page: call `leaving(id)` before navigating;
 *     the list flashes it when it mounts again (pass a `scope`).
 */
export function useReturnFlash(scope?: string) {
  const [flashId, setFlashId] = useState<string | null>(() => {
    if (!scope) return null
    const id = leftFrom.get(scope) ?? null
    leftFrom.delete(scope)
    return id
  })
  const opened = useCallback(() => setFlashId(null), [])
  // Off then on again, so the animation replays for the same row.
  const closed = useCallback((id: string) => { setFlashId(null); setTimeout(() => setFlashId(id), 0) }, [])
  const leaving = useCallback((id: string) => { if (scope) leftFrom.set(scope, id) }, [scope])
  const flashClass = useCallback((id: string) => (id === flashId ? 'mp-last-opened' : undefined), [flashId])
  return { flashId, flashClass, opened, closed, leaving }
}
