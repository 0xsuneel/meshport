// URL guards for content other users control (chat / P2P messages).
// A `javascript:` or `data:` URL passed to window.open or an <img> click
// would run attacker code inside MeshPort's origin, where the wallet lives.

const SUPA_HOST = (() => {
  try { return new URL(import.meta.env.VITE_SUPABASE_URL as string).hostname } catch { return '' }
})()

/** An uploaded image URL from our own Supabase storage, or '' if it isn't one. */
export function safeStorageUrl(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    const okHost = SUPA_HOST ? u.hostname === SUPA_HOST : /\.supabase\.co$/i.test(u.hostname)
    return u.protocol === 'https:' && okHost && u.pathname.startsWith('/storage/v1/object/') ? u.href : ''
  } catch { return '' }
}

/** Opens an http(s) URL in a new tab with no access back to this page. */
export function openExternal(raw: string | null | undefined): void {
  try {
    const u = new URL(String(raw || ''))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return
    window.open(u.href, '_blank', 'noopener,noreferrer')
  } catch { /* not a URL */ }
}
