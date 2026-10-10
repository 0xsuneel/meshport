import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { useAuthStore, useUIStore } from '@/store'
import { useMerchant } from '@/lib/merchant'
import { invalidateConversationsCache } from '@/lib/supabase'
import {
  cachedPrivacy, fetchMyPrivacy, saveMyPrivacy, fetchBlocked, unblockUser,
  type ChatPrivacy, type BlockedPerson,
} from '@/lib/privacy'

// Chats → your profile picture. Who can message you, payments from
// strangers, and the people you've blocked (Unblock brings them back).
export function ChatPrivacyPage() {
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const isMerchant = useMerchant().isMerchant
  const [privacy, setPrivacy] = useState<ChatPrivacy>(() => cachedPrivacy(user?.id))
  const [blocked, setBlocked] = useState<BlockedPerson[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.id) return
    fetchMyPrivacy(user.id).then(setPrivacy).catch(() => {})
    fetchBlocked(user.id).then(setBlocked).catch(() => setBlocked([]))
  }, [user?.id])

  const change = async (patch: Partial<ChatPrivacy>) => {
    if (!user?.id) return
    const before = privacy
    setPrivacy(p => ({ ...p, ...patch }))
    try { setPrivacy(await saveMyPrivacy(user.id, patch)) }
    catch { setPrivacy(before); useUIStore.getState().showToastMessage("Couldn't save - try again", 'error') }
  }

  const unblock = async (p: BlockedPerson) => {
    if (!user?.id || busyId) return
    setBusyId(p.id)
    try {
      await unblockUser(user.id, p.id)
      setBlocked(list => (list ?? []).filter(x => x.id !== p.id))
      invalidateConversationsCache()
      useUIStore.getState().showToastMessage(`${p.username.replace(/\.arc$/, '')}.arc unblocked`, 'success')
    } catch {
      useUIStore.getState().showToastMessage("Couldn't unblock - try again", 'error')
    } finally { setBusyId(null) }
  }

  const groups = [
    { title: 'Who can message me', key: 'msgPrivacy' as const, options: [
      { v: 'everyone', label: 'Everyone', hint: 'Anyone on MeshPort can start a chat with you.' },
      { v: 'contacts', label: 'Contacts only', hint: "Chats from people you don't know go to Requests, without alerts." },
    ] },
    { title: 'Payments from strangers', key: 'strangerPayments' as const, options: [
      { v: 'allow', label: 'Allow', hint: 'Anyone can pay you.' },
      { v: 'block', label: 'Block', hint: "MeshPort won't let people you don't know pay you. Payments sent from outside MeshPort still arrive (nobody can stop a blockchain transfer), just without an alert." },
    ] },
  ]

  const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

  return (
    <div className="flex-1 overflow-y-auto bg-bg" style={{ paddingBottom: 40 }}>
      <div className="sticky top-0 z-20 bg-bg/95 backdrop-blur-md px-5 pt-header pb-3">
        <div className="header-row" style={{ gap: 12 }}>
          <button onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
          <h1 className="text-xl font-bold text-text-primary">Chat privacy</h1>
        </div>
      </div>

      <div className="px-5 space-y-6" style={{ maxWidth: 560, margin: '0 auto' }}>
        <div className="flex items-center gap-3">
          <Avatar name={user?.displayName || user?.username || 'Me'} src={user?.avatar ?? undefined} size="md" />
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-text-primary truncate">{user?.displayName || (user?.username || '').replace(/\.arc$/, '')}</p>
            <p className="text-[13px] text-link">{(user?.username || '').replace(/\.arc$/, '')}.arc</p>
          </div>
        </div>

        {isMerchant ? (
          <p className="text-[13px] text-text-secondary rounded-2xl px-4 py-3" style={card}>
            Merchant accounts accept messages and payments from everyone, so customers can always reach you.
          </p>
        ) : (
          <>
            {groups.map(group => (
              <div key={group.key}>
                <p className="text-[12px] font-bold uppercase tracking-wide text-text-secondary mb-2">{group.title}</p>
                <div role="radiogroup" aria-label={group.title} className="rounded-2xl overflow-hidden" style={card}>
                  {group.options.map((o, i) => {
                    const on = privacy[group.key] === o.v
                    return (
                      <button key={o.v} role="radio" aria-checked={on}
                        onClick={() => change({ [group.key]: o.v } as Partial<ChatPrivacy>)}
                        className="w-full flex items-start gap-3 px-4 py-3 text-left"
                        style={{ borderTop: i ? '1px solid var(--border)' : 'none', background: 'none', cursor: 'pointer' }}>
                        <span className="mt-0.5 flex-shrink-0 rounded-full flex items-center justify-center"
                          style={{ width: 20, height: 20, border: `2px solid ${on ? 'var(--brand)' : 'var(--border)'}` }}>
                          {on && <span className="rounded-full" style={{ width: 10, height: 10, background: 'var(--brand)' }} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[15px] font-semibold text-text-primary">{o.label}</span>
                          <span className="block text-[12.5px] text-text-secondary mt-0.5">{o.hint}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <p className="text-[12px] text-text-muted -mt-3">
              People you know = your contacts, or anyone you've messaged or paid yourself.
            </p>
          </>
        )}

        {/* Blocked contacts */}
        <div>
          <p className="text-[12px] font-bold uppercase tracking-wide text-text-secondary mb-2">
            Blocked contacts{blocked && blocked.length > 0 ? ` · ${blocked.length}` : ''}
          </p>
          <div className="rounded-2xl overflow-hidden" style={card}>
            {blocked === null ? (
              <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-text-secondary" /></div>
            ) : blocked.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-text-secondary">
                No one blocked. Hold a chat (or open a message request) and tap Block.
              </p>
            ) : blocked.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                <Avatar name={p.display_name || p.username} src={p.avatar_url ?? undefined} size="md" />
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold text-text-primary truncate">{p.display_name || p.username.replace(/\.arc$/, '')}</p>
                  <p className="text-[12.5px] text-link truncate">{p.username.replace(/\.arc$/, '')}.arc</p>
                </div>
                <button onClick={() => unblock(p)} disabled={busyId === p.id}
                  className="px-3.5 py-1.5 rounded-full text-[13px] font-bold flex items-center gap-1.5"
                  style={{ background: 'color-mix(in srgb, var(--brand) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)', color: 'var(--brand-text)', cursor: 'pointer' }}>
                  {busyId === p.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Unblock
                </button>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-text-muted mt-2">
            Blocked people can't message you or pay you in MeshPort - they're told you've blocked them.
          </p>
        </div>
      </div>
    </div>
  )
}
