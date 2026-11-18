// A split group in the Chats list (like PhonePe's group rows): the group's own
// name and icon (they stay when new expenses are added), and the latest in it -
// a message, or the latest expense and how many have paid it.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { mySplitGroups, splitGroupSeenAt, money, SPLITS_CHANGED_EVENT, type SplitGroup } from '@/lib/splits'

// Kept on the device per account (18 Nov 2026): the chats list is shown from
// its saved copy at once, and the groups used to arrive only once the server
// answered - on a slow connection they popped in late. Now they show with
// the chats, from the last copy, and refresh in the background.
let cached: { uid: string | undefined; groups: SplitGroup[] } | null = null
const storeKey = (uid: string) => `mp-split-groups:${uid}`
function readSaved(uid: string | undefined): SplitGroup[] {
  if (!uid) return []
  try { const v = JSON.parse(localStorage.getItem(storeKey(uid)) || '[]'); return Array.isArray(v) ? v as SplitGroup[] : [] } catch { return [] }
}
function save(uid: string | undefined, g: SplitGroup[]) {
  if (!uid) return
  try { localStorage.setItem(storeKey(uid), JSON.stringify(g)) } catch { /* storage full / private mode */ }
}

/** The split groups you're in (kept fresh while the list is on screen). */
export function useSplitGroups(enabled: boolean): SplitGroup[] {
  const uid = useAuthStore(s => s.user?.id)
  const [groups, setGroups] = useState<SplitGroup[]>(() => cached?.uid === uid ? cached.groups : readSaved(uid))
  useEffect(() => {
    if (!enabled) return
    let live = true
    if (cached?.uid !== uid) setGroups(readSaved(uid))
    const load = () => mySplitGroups().then(g => { cached = { uid, groups: g }; save(uid, g); if (live) setGroups(g) }).catch(() => {})
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 20_000)
    window.addEventListener(SPLITS_CHANGED_EVENT, load)
    window.addEventListener('focus', load)
    return () => { live = false; clearInterval(t); window.removeEventListener(SPLITS_CHANGED_EVENT, load); window.removeEventListener('focus', load) }
  }, [enabled, uid])
  return groups
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date(now.getTime() - 864e5).toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function SplitGroupRow({ g }: { g: SplitGroup }) {
  const navigate = useNavigate()
  const unread = new Date(g.at).getTime() > splitGroupSeenAt(g.groupId)
  const settled = g.requests > 0 && g.paidCount >= g.requests
  const expense = `${g.emoji ? `${g.emoji} ` : ''}${g.title} ${money(g.total)} · ${settled ? 'All settled' : `${g.paidCount + 1} of ${g.requests + 1} paid`}`
  const preview = g.lastBody ? `${g.lastIsMe ? 'You' : (g.lastSender ?? 'Someone')}: ${g.lastBody}` : expense
  return (
    <button type="button" onClick={() => navigate(`/splits/${g.id}`)}
      className="flex items-center gap-3 px-4 py-3 w-full active:bg-[rgb(var(--text-primary-rgb)/0.05)] transition-colors">
      <div aria-hidden className="relative flex-shrink-0 flex items-center justify-center rounded-full"
        style={{ width: 52, height: 52, background: 'color-mix(in srgb, var(--brand) 14%, var(--surface))', fontSize: 24 }}>
        {g.groupEmoji || '👥'}
        <span className="absolute flex items-center justify-center rounded-full text-[10px] font-bold"
          style={{ right: -2, bottom: -2, minWidth: 20, height: 20, padding: '0 4px', background: 'var(--brand)', color: '#fff', border: '2px solid var(--bg)' }}>{g.people}</span>
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-semibold text-text-primary truncate">{g.groupName}</span>
          <span className="text-[12px] flex-shrink-0" style={{ color: unread ? 'var(--brand-text)' : 'var(--text-secondary)', fontWeight: unread ? 700 : 500 }}>{timeLabel(g.at)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-[13.5px] truncate" style={{ color: unread ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: unread ? 600 : 400 }}>{preview}</span>
          {unread && <span className="flex-shrink-0 rounded-full" style={{ width: 9, height: 9, background: 'var(--brand)' }} />}
        </div>
      </div>
    </button>
  )
}
