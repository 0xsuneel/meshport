import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })

import { readChatListCache, writeChatListCache, CHAT_LIST_CACHE_PREFIX } from './chatListCache'

const row = (id: string, last_message: string | null, last_message_type?: string) =>
  ({ id, participant_a: 'me', participant_b: 'x' + id, last_message, last_message_type, last_message_at: '2026-11-10T00:00:00Z', created_at: '2026-11-01T00:00:00Z' }) as any

describe('chatListCache', () => {
  beforeEach(() => store.clear())

  it('stores sealed and payment previews, never readable chat text', () => {
    writeChatListCache('me', [row('1', 'e2e:v2:SEALED'), row('2', 'hello there', 'text'), row('3', 'Paid 5 USDC', 'payment_sent'), row('4', null)])
    const raw = store.get(CHAT_LIST_CACHE_PREFIX + 'me')!
    expect(raw).not.toContain('hello there')
    const list = readChatListCache('me')!
    expect(list.map(c => c.last_message)).toEqual(['e2e:v2:SEALED', null, 'Paid 5 USDC', null])
    expect(list.map(c => c.id)).toEqual(['1', '2', '3', '4']) // the rows themselves all stay
  })

  it('is per account, and tolerates missing / broken data', () => {
    writeChatListCache('me', [row('1', null)])
    expect(readChatListCache('someone-else')).toBeNull()
    expect(readChatListCache(null)).toBeNull()
    store.set(CHAT_LIST_CACHE_PREFIX + 'me', '{oops')
    expect(readChatListCache('me')).toBeNull()
  })

  it('keeps at most 100 chats', () => {
    writeChatListCache('me', Array.from({ length: 250 }, (_, i) => row(String(i), null)))
    expect(readChatListCache('me')!.length).toBe(100)
  })
})
