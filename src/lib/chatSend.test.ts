// lib/chatSend.ts - the one chat send path (ChatPage's composer and the
// background card sender). Real crypto (makeChatKeys); the conversation /
// persist / touch calls and the signed-in user are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { auth, svc } = vi.hoisted(() => ({
  auth: { user: { id: 'me' } as { id: string } | null, walletAddress: '0xme' },
  svc: {
    ensureConversation: vi.fn(async (_a: string, _b: string): Promise<string | null> => 'conv-1'),
    persistMessage: vi.fn(async (p: any): Promise<any> => ({ id: 'm1', conversation_id: p.conversationId, sender_id: p.senderId, content: p.content, type: 'text' })),
    touchConversation: vi.fn(async () => {}),
  },
}))
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/security', () => ({ sealForDevice: async () => null, openFromDevice: async () => null }))
vi.mock('./chatService', () => svc)

import { sendChatText, sealChatText, isPaymentRecordCard } from './chatSend'
import { deriveMyChatIdentity, makeChatKeys, decryptText } from './chatCrypto'
import { paymentRequestMessage, billCardMessage } from './merchantPay'

const alice = deriveMyChatIdentity('0x' + '11'.repeat(32))
const bob = deriveMyChatIdentity('0x' + '22'.repeat(32))
const card = paymentRequestMessage({ code: 'abc123xyz', orderNumber: 'ORD-100001', amount: 12.5 }, '12.5')

beforeEach(() => { vi.clearAllMocks(); auth.user = { id: 'me' } })

describe('isPaymentRecordCard', () => {
  it('is true only for a bill / request card with its pay link', () => {
    expect(isPaymentRecordCard(card)).toBe(true)
    expect(isPaymentRecordCard(billCardMessage({ code: 'abc123xyz', amount: 3, items: [{ name: 'Tea', qty: 2 }] }, '3'))).toBe(true)
    expect(isPaymentRecordCard('💸 Payment request but no link')).toBe(false)
    expect(isPaymentRecordCard('hello https://x/pay/r/abc123xyz')).toBe(false)
  })
})

describe('sealChatText', () => {
  it('keeps cards plain without asking for keys', async () => {
    const keys = vi.fn()
    expect(await sealChatText(card, keys)).toBe(card)
    expect(keys).not.toHaveBeenCalled()
  })
  it('seals text for the recipient (e2e:v2) and for me alone when they have no key yet (e2e:q2)', async () => {
    const v2 = await sealChatText('hi bob', async () => makeChatKeys(alice.privateKey, bob.publicKey))
    expect(v2.startsWith('e2e:v2:')).toBe(true)
    expect(await decryptText(v2, await makeChatKeys(bob.privateKey, alice.publicKey))).toBe('hi bob')
    const q2 = await sealChatText('hi bob', async () => makeChatKeys(alice.privateKey, null))
    expect(q2.startsWith('e2e:q2:')).toBe(true)
  })
})

describe('sendChatText', () => {
  it('opens the conversation, saves the card as is and touches the conversation', async () => {
    const r = await sendChatText({ toUserId: 'bob', text: card })
    expect(svc.ensureConversation).toHaveBeenCalledWith('me', 'bob')
    expect(svc.persistMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', senderId: 'me', content: card, type: 'text' }))
    expect(svc.touchConversation).toHaveBeenCalledWith('conv-1', card, 'me', 'text')
    expect(r).toMatchObject({ conversationId: 'conv-1', content: card })
  })
  it('uses a known conversation and the given keys (ChatPage), reporting the sealed content first', async () => {
    const sealed: string[] = []
    const r = await sendChatText({ conversationId: 'c9', text: 'hello', replyToId: 'q1', keys: async () => makeChatKeys(alice.privateKey, bob.publicKey), onSealed: c => sealed.push(c) })
    expect(svc.ensureConversation).not.toHaveBeenCalled()
    expect(sealed).toEqual([r.content])
    expect(r.content.startsWith('e2e:v2:')).toBe(true)
    expect(svc.persistMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c9', replyToId: 'q1', content: r.content }))
  })
  it('fails without saving when the chat cannot be opened or saving fails', async () => {
    svc.ensureConversation.mockResolvedValueOnce(null)
    await expect(sendChatText({ toUserId: 'bob', text: card })).rejects.toThrow('Could not open the chat')
    expect(svc.persistMessage).not.toHaveBeenCalled()
    svc.persistMessage.mockResolvedValueOnce(null)
    await expect(sendChatText({ toUserId: 'bob', text: card })).rejects.toThrow('Could not send the message')
    expect(svc.touchConversation).not.toHaveBeenCalled()
  })
  it('needs a signed-in user', async () => {
    auth.user = null
    await expect(sendChatText({ toUserId: 'bob', text: card })).rejects.toThrow(/Sign in/)
  })
})
