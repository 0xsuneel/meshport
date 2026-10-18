// Crashes on people's devices (the "Something went wrong" screen and uncaught
// errors) are saved to client_errors, so they can be diagnosed without asking
// for a screenshot. Each distinct error once per session, at most a few per
// session; a stale build (handled by its own reload) and offline failures are
// skipped. Never throws.
import { supabase } from './supabase'
import { isChunkLoadError } from './lazyRetry'

type Kind = 'route' | 'uncaught' | 'rejection'
const MAX_PER_SESSION = 5
const sent = new Set<string>()

const build = () => {
  try {
    const src = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ?? ''
    return src.split('/').pop()?.slice(0, 80) ?? ''
  } catch { return '' }
}

export function reportClientError(kind: Kind, error: unknown): void {
  try {
    if (isChunkLoadError(error) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
    const e = error as { message?: string; stack?: string; status?: number; statusText?: string } | null
    const message = (e?.status ? `${e.status} ${e.statusText ?? ''} ` : '') + (e?.message ?? String(error))
    const key = `${kind}:${message}`
    if (sent.has(key) || sent.size >= MAX_PER_SESSION) return
    sent.add(key)
    void supabase.from('client_errors').insert({
      kind,
      path: window.location.pathname.slice(0, 300),
      message: message.slice(0, 1000),
      stack: (e?.stack ?? '').slice(0, 4000),
      user_agent: navigator.userAgent.slice(0, 400),
      build: build(),
    }).then(() => {}, () => {})
  } catch { /* reporting must never break the app */ }
}
