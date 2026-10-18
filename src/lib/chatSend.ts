// Send one text message into a 1:1 chat - the same path ChatPage's composer
// uses, so a message sent from elsewhere (Business → Charge / Bill with a
// customer, Receive → Request) looks and is stored exactly like one typed in
// the chat:
//   1. the conversation with that person (ensureConversation - made if new)
//   2. sealed like every chat message: end-to-end encrypted for them (e2e:v2),
//      or for the sender alone until they have a chat key (e2e:q2, handed
//      over later by resealWaitingMessages). Bill / payment-request cards are
//      payment records and stay plain text, exactly as in ChatPage.
//   3. saved (persistMessage → /api/chat) and the conversation's last
//      message updated (touchConversation).
// ChatPage keeps its own optimistic bubble / retry around this.
import { useAuthStore } from '@/store'
import { ensureConversation, persistMessage, touchConversation, type ChatMessage } from './chatService'
import { codeFromLink } from './merchantPay'
import type { ChatKeys } from './chatCrypto'

/** A 🧾 Bill / 💸 Payment request card with its pay link (stored as plain text). */
export function isPaymentRecordCard(text: string): boolean {
  return /^(🧾 Bill|💸 Payment request)\b/u.test(text) && !!codeFromLink(text)
}

/** No chat identity on this device yet (wallet locked): nothing is sent readable. */
export class NoChatKeyError extends Error {
  constructor() { super('Unlock your wallet to send encrypted messages'); this.name = 'NoChatKeyError' }
}

/** This device's keys for the chat with `otherUserId` (throws NoChatKeyError without them). */
export async function chatKeysFor(otherUserId: string): Promise<ChatKeys> {
  const addr = useAuthStore.getState().walletAddress
  const { getConversationKey } = await import('./chatCrypto')
  const k = addr ? await getConversationKey(addr, otherUserId).catch(() => null) : null
  if (!k) throw new NoChatKeyError()
  return k
}

/** What a chat message is stored as: cards as they are, everything else
 *  encrypted with `keys()` (only asked for when needed). */
export async function sealChatText(text: string, keys: () => Promise<ChatKeys>): Promise<string> {
  if (isPaymentRecordCard(text)) return text
  const { encryptText } = await import('./chatCrypto')
  return encryptText(text, await keys())
}

export interface SendChatTextParams {
  /** The other person (their user id). Needed unless `conversationId` and `keys` are given. */
  toUserId?: string | null
  text: string
  /** Already known (ChatPage); otherwise found or made with ensureConversation. */
  conversationId?: string | null
  replyToId?: string | null
  /** The chat's keys (ChatPage passes its own, which also explains a locked wallet). */
  keys?: () => Promise<ChatKeys>
  /** The stored content, before it's saved (ChatPage shows the text for it at once). */
  onSealed?: (content: string) => void
}

export interface SentChatText { conversationId: string; message: ChatMessage; content: string }

/** Sends `text` as the signed-in user. Throws with a message on any failure. */
export async function sendChatText(p: SendChatTextParams): Promise<SentChatText> {
  const me = useAuthStore.getState().user?.id
  if (!me) throw new Error('Sign in to send messages')
  const text = p.text.trim()
  if (!text) throw new Error('Nothing to send')
  const other = p.toUserId ? String(p.toUserId) : null
  const conversationId = p.conversationId || (other ? await ensureConversation(String(me), other) : null)
  if (!conversationId) throw new Error('Could not open the chat')
  const keys = p.keys ?? (() => {
    if (!other) throw new Error('No one to send to')
    return chatKeysFor(other)
  })
  const content = await sealChatText(text, keys)
  p.onSealed?.(content)
  const message = await persistMessage({ conversationId, senderId: String(me), content, type: 'text', replyToId: p.replyToId ?? null })
  if (!message) throw new Error('Could not send the message')
  void touchConversation(conversationId, content, String(me), 'text')
  return { conversationId, message, content }
}
