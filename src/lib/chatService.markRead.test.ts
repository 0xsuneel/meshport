// src/lib/chatService.markRead.test.ts
//
// Regression test for the self-chat unread bug (2026-09-03): markRead's PATCH
// filtered on `sender_id=neq.${myId}`, which matches ZERO rows in a
// self-conversation (participant_a === participant_b === myId), since every
// message there — including the payment_received mirror row, whose
// sender_id is deliberately rewritten to the recipient's id elsewhere — has
// sender_id === myId too. Those messages could never be marked read, so a
// self-chat's unread badge only ever grew, one row per self-payment,
// forever (reported as "why is my own account showing 29 unread").
//
// Fixed by looking up the conversation's participants first and dropping
// the sender_id filter entirely when it's a self-chat. Pinned here by
// asserting the exact PATCH URL markRead builds in each case, via a stubbed
// global fetch — no real network, no live Supabase project needed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// chatService.ts imports @/lib/supabase for its realtime client, which
// constructs a real Supabase client at module load and throws without env
// vars — same issue ActivityPage.test.ts hit. markRead never touches
// _sbClient except inside authHeaders' try/catch (which falls back to the
// anon key on any failure), so a minimal stub is enough here.
vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}))

import { markRead } from './chatService'

const CONV_ID = 'conv-123'
const MY_ID   = 'user-abc'
const OTHER_ID = 'user-xyz'

function mockFetchSequence(convRow: { participant_a: string; participant_b: string }) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    if (url.includes('/conversations?')) {
      return { ok: true, json: async () => [convRow] } as any
    }
    // The PATCH to /messages
    return { ok: true, json: async () => [] } as any
  }))
  return calls
}

describe('markRead — self-chat unread fix', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops the sender_id filter for a self-chat (participant_a === participant_b)', async () => {
    const calls = mockFetchSequence({ participant_a: MY_ID, participant_b: MY_ID })

    await markRead(CONV_ID, MY_ID)

    const patchCall = calls.find(u => u.includes('/messages?'))
    expect(patchCall).toBeDefined()
    expect(patchCall).not.toContain('sender_id')
    expect(patchCall).toContain(`conversation_id=eq.${CONV_ID}`)
    expect(patchCall).toContain('is_read=eq.false')
  })

  it('keeps the sender_id filter for an ordinary two-person chat', async () => {
    const calls = mockFetchSequence({ participant_a: MY_ID, participant_b: OTHER_ID })

    await markRead(CONV_ID, MY_ID)

    const patchCall = calls.find(u => u.includes('/messages?'))
    expect(patchCall).toBeDefined()
    expect(patchCall).toContain(`sender_id=neq.${MY_ID}`)
  })

  it('does not throw if the conversation lookup fails — falls back to the safe (sender-filtered) behavior', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/conversations?')) throw new Error('network down')
      return { ok: true, json: async () => [] } as any
    }))

    await expect(markRead(CONV_ID, MY_ID)).resolves.toBeUndefined()
  })
})
