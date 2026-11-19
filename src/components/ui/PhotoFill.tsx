// A person's profile photo laid over their initials badge (19 Nov 2026).
// The badge keeps its initials underneath, so a person without a photo, a
// photo still loading or one that fails to load shows the initials as before.
// Put it inside a badge with position: relative (or grid) and overflow hidden.
import { useState } from 'react'
import { useUserAvatars } from '@/lib/userAvatars'

/** "suneel.arc" / "suneel" → "suneel"; anything that isn't a MeshPort name → null. */
export function usernameOf(s: string | null | undefined): string | null {
  const v = String(s ?? '').trim().toLowerCase().replace(/^@/, '')
  if (!v || v.startsWith('0x') || /\s/.test(v)) return null
  const m = /^([a-z0-9_-]{2,32})(\.arc)?$/.exec(v)
  return m ? m[1] : null
}

export function PhotoFill({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null)
  const url = src ? src.split('?')[0] : null
  if (!url || failed === url) return null
  return (
    <img src={url} alt="" decoding="async" onError={() => setFailed(url)}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
  )
}

/** The photo for one MeshPort name (looked up once per session). */
export function UserPhoto({ name }: { name: string | null | undefined }) {
  const u = usernameOf(name)
  const photos = useUserAvatars([u])
  return <PhotoFill src={u ? photos.get(u) : null} />
}
