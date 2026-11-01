import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChatMessage } from './chatService'

let ME = ''
const THEM = 'them-2'
let n = 0
const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: `m${++n}`, conversation_id: 'c1', sender_id: THEM, content: 'e2e:v2:x', type: 'text',
  payment_amount: null, payment_tx_hash: null, token_symbol: null, is_read: false,
  created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(), ...p,
})

describe('localChat', () => {
  let lc: typeof import('./localChat')
  beforeEach(async () => {
    vi.resetModules()
    ME = 'me-' + crypto.randomUUID()
    lc = await import('./localChat')
    lc._resetLocalChat()
  })

  it('keeps chat rows only - never payment cards or signals', async () => {
    await lc.putMessages(ME, [msg({}), msg({ type: 'payment_sent' }), msg({ type: 'signal' })])
    const rows = await lc.getMessages(ME, 'c1')
    expect(rows.map(r => r.type)).toEqual(['text'])
  })

  it('pages newest first, returned oldest first', async () => {
    const all = Array.from({ length: 5 }, () => msg({}))
    await lc.putMessages(ME, all)
    const last2 = await lc.getMessages(ME, 'c1', 2)
    expect(last2.map(r => r.id)).toEqual([all[3].id, all[4].id])
    const before = await lc.getMessages(ME, 'c1', 2, all[3].created_at)
    expect(before.map(r => r.id)).toEqual([all[1].id, all[2].id])
  })

  it('a re-saved message keeps its receipts', async () => {
    const m = msg({ sender_id: ME })
    await lc.putMessages(ME, [m])
    await lc.patchMessages(ME, [m.id], { delivered_at: '2026-11-01T01:00:00Z', read_at: '2026-11-01T01:01:00Z', is_read: true })
    await lc.putMessages(ME, [{ ...m }])
    const [got] = await lc.getMessages(ME, 'c1')
    expect(got.read_at).toBe('2026-11-01T01:01:00Z')
    expect(got.is_read).toBe(true)
  })

  it('counts and marks the other person\'s unread messages', async () => {
    await lc.putMessages(ME, [msg({}), msg({}), msg({ sender_id: ME }), msg({ conversation_id: 'c2' })])
    expect(await lc.unreadCount(ME, [ME])).toBe(3)
    const ids = await lc.markConversationRead(ME, 'c1', [ME])
    expect(ids).toHaveLength(2)
    const s = await lc.summaries(ME, [ME])
    expect(s.get('c1')!.unread).toBe(0)
    expect(s.get('c2')!.unread).toBe(1)
  })

  it('the preview skips deleted messages', async () => {
    const a = msg({ content: 'first' })
    const b = msg({ content: '[deleted]', deleted_at: 'x' })
    await lc.putMessages(ME, [a, b])
    expect((await lc.summaries(ME, [ME])).get('c1')!.last!.id).toBe(a.id)
  })
})
