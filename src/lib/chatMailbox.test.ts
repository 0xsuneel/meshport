import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('./supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }))

let ME = ''
const THEM = 'them-2'
const row = (p: Record<string, unknown>) => ({
  id: crypto.randomUUID(), conversation_id: 'c1', sender_id: THEM, content: 'e2e:v2:x', type: 'text',
  payment_amount: null, payment_tx_hash: null, token_symbol: null, is_read: false,
  created_at: new Date().toISOString(), ...p,
})

describe('chatMailbox', () => {
  let mb: typeof import('./chatMailbox')
  let lc: typeof import('./localChat')
  beforeEach(async () => {
    vi.resetModules()
    rpc.mockReset()
    ME = 'me-' + crypto.randomUUID()
    lc = await import('./localChat')
    lc._resetLocalChat()
    mb = await import('./chatMailbox')
  })

  it('saves on the phone before acknowledging, and marks them delivered', async () => {
    const incoming = row({})
    const order: string[] = []
    rpc.mockImplementation(async (fn: string, args: any) => {
      order.push(fn)
      if (fn === 'chat_peek_mail') return { data: order.filter(f => f === 'chat_peek_mail').length === 1 ? [incoming] : [], error: null }
      if (fn === 'chat_ack_mail') {
        // Already on the phone when the server is told to delete it.
        expect((await lc.getMessages(ME, 'c1')).map(m => m.id)).toEqual([incoming.id])
        expect(args.p_ids).toEqual([incoming.id])
        return { data: 1, error: null }
      }
      return { data: null, error: null }
    })
    expect(await mb.syncMailbox(ME)).toBe(1)
    expect(order).toEqual(['chat_peek_mail', 'chat_ack_mail'])
    const [saved] = await lc.getMessages(ME, 'c1')
    expect(saved.delivered_at).toBeTruthy()
  })

  it('does not acknowledge when saving on the phone fails', async () => {
    vi.resetModules()
    vi.doMock('./localChat', () => ({ putMessages: vi.fn().mockRejectedValue(new Error('disk full')), patchMessages: vi.fn() }))
    const broken = await import('./chatMailbox')
    rpc.mockResolvedValue({ data: [row({})], error: null })
    expect(await broken.syncMailbox(ME)).toBe(0)
    expect(rpc.mock.calls.map(c => c[0])).toEqual(['chat_peek_mail'])
    vi.doUnmock('./localChat')
  })

  it('applies receipts to my messages and deletes only the author\'s', async () => {
    const mine = row({ sender_id: ME })
    const theirs = row({})
    await lc.putMessages(ME, [mine, theirs])
    await mb.applySignal(ME, THEM, { kind: 'read', ids: [mine.id, theirs.id], at: '2026-11-01T02:00:00Z' })
    let rows = await lc.getMessages(ME, 'c1')
    expect(rows.find(r => r.id === mine.id)!.read_at).toBe('2026-11-01T02:00:00Z')
    expect(rows.find(r => r.id === theirs.id)!.read_at ?? null).toBeNull()
    await mb.applySignal(ME, THEM, { kind: 'delete', ids: [mine.id, theirs.id], at: '2026-11-01T03:00:00Z' })
    rows = await lc.getMessages(ME, 'c1')
    expect(rows.find(r => r.id === theirs.id)!.content).toBe('[deleted]')
    expect(rows.find(r => r.id === mine.id)!.content).toBe('e2e:v2:x')
  })

  it('parses only well-formed signals', () => {
    expect(mb.parseSignal('{"kind":"read","ids":["a"],"at":"t"}')).toEqual({ kind: 'read', ids: ['a'], at: 't' })
    expect(mb.parseSignal('{"kind":"evil","ids":["a"]}')).toBeNull()
    expect(mb.parseSignal('nope')).toBeNull()
  })

  it('before the migration runs, does nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Could not find the function public.chat_peek_mail' } })
    expect(await mb.syncMailbox(ME)).toBe(0)
  })
})
