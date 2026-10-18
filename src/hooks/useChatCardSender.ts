// Posts an order's card (💸 Payment request / 🧾 Bill) into the chat with
// its customer in the background - the screen that made the order stays put
// and shows "Sent to … in chat" (or Retry). Uses the chat's own send path
// (lib/chatSend.ts), so the card is the same one the chat sheets send.
import { useCallback, useRef, useState } from 'react'

export interface ChatCardTarget { id: string; name: string }
export type ChatCardStatus =
  | { state: 'idle' }
  | { state: 'sending' | 'sent' | 'failed'; to: ChatCardTarget; text: string; conversationId?: string; error?: string }

export function useChatCardSender() {
  const [status, setStatus] = useState<ChatCardStatus>({ state: 'idle' })
  // Only the latest send updates the line (a new order replaces the old one).
  const run = useRef(0)
  const send = useCallback(async (to: ChatCardTarget, text: string) => {
    const k = ++run.current
    setStatus({ state: 'sending', to, text })
    try {
      const { sendChatText } = await import('@/lib/chatSend')
      const r = await sendChatText({ toUserId: to.id, text })
      if (k === run.current) setStatus({ state: 'sent', to, text, conversationId: r.conversationId })
    } catch (e) {
      console.error('[chat card] send failed:', e)
      if (k === run.current) setStatus({ state: 'failed', to, text, error: e instanceof Error ? e.message : 'Could not send' })
    }
  }, [])
  const retry = useCallback(() => { if (status.state === 'failed') void send(status.to, status.text) }, [status, send])
  const reset = useCallback(() => { run.current++; setStatus({ state: 'idle' }) }, [])
  return { status, send, retry, reset }
}
