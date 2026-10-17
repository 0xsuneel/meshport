// Business → Auto-settle reminder. Moving money needs the wallet key, which
// never leaves the phone, so MeshPort can't settle on its own while the app
// is closed. Instead the merchant picks a schedule (every 6 hours, or daily
// at a time); when it is due and USDC is waiting on other chains, Business
// asks "Time to settle $X" (and a phone notification, when allowed).
import { useEffect, useState } from 'react'

export type AutoSchedule = 'off' | '6h' | 'daily'
export type AutoSettleSettings = { schedule: AutoSchedule; time: string; lastPrompt: number }

const KEY = 'meshport_auto_settle'
const read = (): AutoSettleSettings => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v?.schedule) return { time: '21:00', lastPrompt: 0, ...v } } catch { /* storage off */ }
  return { schedule: 'off', time: '21:00', lastPrompt: 0 }
}
const write = (v: AutoSettleSettings) => { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* storage off */ } }

/** When the next reminder is due (ms), from the last one. */
export function nextDue(s: AutoSettleSettings, now = Date.now()): number | null {
  if (s.schedule === 'off') return null
  if (s.schedule === '6h') return (s.lastPrompt || now) + 6 * 3_600_000
  const [h, m] = s.time.split(':').map(Number)
  const at = new Date(now); at.setHours(h || 0, m || 0, 0, 0)
  // Today's time if it hasn't been prompted since then, else tomorrow's.
  if (at.getTime() <= now && s.lastPrompt < at.getTime()) return at.getTime()
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

export function useAutoSettle(waitingTotal: number) {
  const [settings, setSettings] = useState(read)
  const [due, setDue] = useState(false)
  const update = (patch: Partial<AutoSettleSettings>) => setSettings(s => {
    const next = { ...s, ...patch, ...(patch.schedule && patch.schedule !== s.schedule ? { lastPrompt: Date.now() } : {}) }
    write(next); return next
  })

  useEffect(() => {
    const check = () => {
      const at = nextDue(settings)
      if (at === null || waitingTotal < 1 || Date.now() < at) return
      setDue(true)
      update({ lastPrompt: Date.now() })
      try {
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          new Notification('Time to settle', { body: `$${waitingTotal.toFixed(2)} USDC is waiting on other chains. Open Business to move it to Arc.` })
        }
      } catch { /* notifications unavailable */ }
    }
    check()
    const t = setInterval(check, 60_000)
    return () => clearInterval(t)
  }, [settings.schedule, settings.time, settings.lastPrompt, waitingTotal])

  const at = nextDue(settings)
  const nextLabel = at ? `Next reminder ${new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : undefined
  return { settings, update, due, dismiss: () => setDue(false), nextLabel }
}
