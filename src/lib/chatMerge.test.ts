import { describe, it, expect } from 'vitest'
import { mergeNewest, type ChatMessage } from './chatService'

const m = (id: string, at: number, extra: Partial<ChatMessage> = {}) => ({ id, created_at: new Date(at * 1000).toISOString(), ...extra }) as ChatMessage

describe('mergeNewest (phone chat + server payment cards)', () => {
  it('interleaves by time and keeps the newest `limit`, oldest first', () => {
    const local = [m('t1', 1), m('t3', 3), m('t5', 5)]
    const server = [m('p4', 4), m('p2', 2)]
    expect(mergeNewest(server, local, 3).map(x => x.id)).toEqual(['t3', 'p4', 't5'])
  })
  it('one copy per id', () => {
    expect(mergeNewest([m('a', 1, { is_read: false })], [m('a', 1, { is_read: true })], 10)).toHaveLength(1)
  })
})
