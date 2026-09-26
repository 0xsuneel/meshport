// Forward selected messages to up to 5 chats (WhatsApp-style). Each copy is
// re-encrypted for its new chat — photos and files are decrypted with this
// chat's key and uploaded again with the other chat's key — and carries a
// "Forwarded" label. Payments and payment records are never forwarded.
import { useEffect, useMemo, useState } from 'react'
import { SHEET_SPRING, SHEET_BACKDROP } from '@/lib/motion'
import { motion } from 'framer-motion'
import { X, Search, Check, Loader2 } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { plainTextOf, parseMedia } from './chatMessageText'

const MAX_TARGETS = 5

export function ChatForwardSheet({ messages, sourceKey, myUserId, walletAddress, onClose, onDone, onError }: {
  messages: any[]
  sourceKey: any
  myUserId: string
  walletAddress: string | null
  onClose: () => void
  onDone: (chatCount: number) => void
  onError: (msg: string) => void
}) {
  const [convs, setConvs] = useState<any[] | null>(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [sending, setSending] = useState(false)

  useEffect(() => {
    import('@/lib/supabase').then(({ fetchConversations }) => fetchConversations(myUserId))
      .then(list => setConvs((list ?? []).filter((c: any) => c.other_user?.id)))
      .catch(() => setConvs([]))
  }, [myUserId])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^@/, '')
    return (convs ?? []).filter(c => !needle
      || String(c.other_user?.display_name ?? '').toLowerCase().includes(needle)
      || String(c.other_user?.username ?? '').toLowerCase().includes(needle))
  }, [convs, q])

  const toggle = (id: string) => setPicked(p => p.includes(id) ? p.filter(x => x !== id)
    : p.length >= MAX_TARGETS ? (onError(`You can forward to up to ${MAX_TARGETS} chats`), p) : [...p, id])

  const send = async () => {
    if (!picked.length || sending) return
    setSending(true)
    try {
      const [{ getConversationKey, encryptText, decryptBlob, encryptBlob }, { persistMessage, touchConversation }, { supabase }] =
        await Promise.all([import('@/lib/chatCrypto'), import('@/lib/chatService'), import('@/lib/supabase')])
      const ordered = [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      // Photo / file bytes decrypted once, re-encrypted per chat.
      const plainBlobs = new Map<string, Blob>()
      let failed = 0
      for (const convId of picked) {
        const conv = (convs ?? []).find(c => c.id === convId)
        const key = walletAddress && conv?.other_user?.id ? await getConversationKey(walletAddress, conv.other_user.id).catch(() => null) : null
        for (const m of ordered) {
          try {
            const plain = plainTextOf(m.content)
            if (!plain) { failed++; continue }
            const media = parseMedia(plain)
            let marker = plain
            if (media) {
              let blob = plainBlobs.get(m.id)
              if (!blob) {
                const res = await fetch(media.url)
                if (!res.ok) throw new Error('download failed')
                const bytes = await res.arrayBuffer()
                blob = media.encrypted ? await decryptBlob(bytes, media.iv, sourceKey) : new Blob([bytes])
                plainBlobs.set(m.id, blob)
              }
              const { blob: up, ivBase64, encrypted } = await encryptBlob(blob, key)
              const ext = media.kind === 'image' ? 'jpg' : (media.name.split('.').pop() || 'bin')
              const path = `chat/${convId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
              const { error } = await supabase.storage.from('attachments').upload(path, up, { cacheControl: '3600', upsert: false, contentType: encrypted ? 'application/octet-stream' : (blob.type || 'application/octet-stream') })
              if (error) throw error
              const url = supabase.storage.from('attachments').getPublicUrl(path).data.publicUrl
              const safeName = encodeURIComponent(media.name)
              marker = media.kind === 'image'
                ? (encrypted ? `[IMAGE-E:${ivBase64}](${url})` : `[IMAGE](${url})`)
                : (encrypted ? `[FILE-E:${safeName}:${ivBase64}](${url})` : `[FILE:${safeName}](${url})`)
              // Keep the photo / file's caption with it.
              if (media.caption) marker += `\n${media.caption}`
            }
            const content = await encryptText(marker, key)
            const saved = await persistMessage({ conversationId: convId, senderId: myUserId, content, type: 'text', forwarded: true })
            if (!saved) { failed++; continue }
            touchConversation(convId, content, myUserId, 'text')
          } catch { failed++ }
        }
      }
      if (failed) onError(failed === 1 ? '1 message could not be forwarded' : `${failed} messages could not be forwarded`)
      onDone(picked.length)
    } finally {
      setSending(false)
    }
  }

  const names = picked.map(id => (convs ?? []).find(c => c.id === id)?.other_user?.display_name || (convs ?? []).find(c => c.id === id)?.other_user?.username).filter(Boolean)

  return (
    <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={SHEET_SPRING}
      className="absolute inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }}>
      <div className="flex items-center gap-3 px-4 pt-header pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <button onClick={onClose} className="back-btn" aria-label="Close"><X className="w-5 h-5 text-text-primary" /></button>
        <div className="flex-1 min-w-0">
          <p className="text-[16px] font-semibold text-text-primary">Forward to…</p>
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{picked.length} of {MAX_TARGETS} selected · {messages.length} message{messages.length === 1 ? '' : 's'}</p>
        </div>
      </div>
      <div className="px-4 py-2">
        <label className="flex items-center gap-2 rounded-full px-3.5" style={{ height: 40, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
          <Search className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or username" autoCapitalize="none"
            className="flex-1 bg-transparent text-sm text-text-primary focus:outline-none" />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto pb-28">
        {convs === null ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--brand)' }} /></div>
        ) : shown.length === 0 ? (
          <p className="text-center text-sm py-10" style={{ color: 'var(--text-secondary)' }}>No chats found</p>
        ) : shown.map(c => {
          const on = picked.includes(c.id)
          return (
            <button key={c.id} type="button" onClick={() => toggle(c.id)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left active:opacity-70">
              <Avatar name={c.other_user?.display_name ?? c.other_user?.username ?? ''} src={c.other_user?.avatar_url ?? null} size="md" />
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-text-primary truncate">{c.other_user?.display_name || c.other_user?.username}</p>
                <p className="text-[12.5px] truncate" style={{ color: 'var(--text-secondary)' }}>{String(c.other_user?.username ?? '').replace(/\.arc$/, '')}.arc</p>
              </div>
              <span className="flex items-center justify-center rounded-full flex-shrink-0"
                style={{ width: 22, height: 22, border: on ? 'none' : '2px solid var(--text-muted)', background: on ? 'var(--brand)' : 'transparent' }}>
                {on && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
              </span>
            </button>
          )
        })}
      </div>
      {picked.length > 0 && (
        <div className="absolute left-0 right-0 bottom-0 flex items-center gap-3 px-4 pt-3" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
          <p className="flex-1 min-w-0 truncate text-sm" style={{ color: 'var(--text-secondary)' }}>{names.join(', ')}</p>
          <button onClick={send} disabled={sending} aria-label={`Send to ${picked.length} chat${picked.length === 1 ? '' : 's'}`}
            className="flex items-center justify-center rounded-full text-white disabled:opacity-60" style={{ width: 52, height: 52, background: 'var(--brand)' }}>
            {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : (
              <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.5-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 001.4 1.1z" /></svg>
            )}
          </button>
        </div>
      )}
    </motion.div>
  )
}
