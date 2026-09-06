// ChatDesktopSplit.tsx
// Pathless layout route wrapping the existing `/chat` and `/chat/:id`
// routes (see App.tsx) — adds a structural wrapper only, the routes'
// paths/params/navigation behavior are completely unchanged. On mobile
// this renders <Outlet/> and nothing else, identical to before this file
// existed. On desktop it pins the chat list (passed in as `list` — App.tsx
// hands it the same lazy-loaded <ChatListPage/> element already used for
// the bare `/chat` route, so this doesn't statically import it and undo
// the route-level code-splitting) in a fixed-width left column, and
// renders <Outlet/> — ChatConversationPage — in the remaining right column
// whenever `:id` is present; otherwise a lightweight "select a
// conversation" placeholder (Outlet would otherwise just render the list
// a second time, since that's literally what the bare `/chat` route's own
// element is).
import { type ReactNode } from 'react'
import { Outlet, useParams } from 'react-router-dom'
import { MessageCircle } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

export function ChatDesktopSplit({ list }: { list: ReactNode }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { id } = useParams<{ id?: string }>()

  if (!isDesktop) return <Outlet />

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 360, flexShrink: 0, height: '100%', minHeight: 0, borderRight: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {list}
      </div>
      <div style={{ flex: 1, minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {id ? (
          <Outlet />
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text-secondary)', background: 'var(--bg)' }}>
            <div style={{
              width: 76, height: 76, borderRadius: '50%',
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--brand) 16%, var(--surface)) 0%, var(--surface) 100%)',
              border: '1px solid var(--border)', boxShadow: 'var(--shadow-1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <MessageCircle size={30} color="var(--brand)" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Select a conversation</p>
              <p style={{ fontSize: 13, margin: '4px 0 0' }}>Choose someone from the list to start chatting</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
