// One line under an order: "Sent to Priya in chat · Open chat", "Sending to
// Priya in chat…" or "Couldn't send in chat · Retry" (useChatCardSender).
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import type { ChatCardStatus } from '@/hooks/useChatCardSender'

export function ChatSentLine({ status, onRetry, onOpen, className = '' }: {
  status: ChatCardStatus; onRetry: () => void; onOpen: (conversationId: string) => void; className?: string
}) {
  if (status.state === 'idle') return null
  const link = 'font-semibold text-link underline-offset-2 hover:underline'
  return (
    <p className={`inline-flex items-center justify-center flex-wrap gap-x-1.5 gap-y-0.5 text-[12.5px] text-text-secondary ${className}`} role="status" aria-live="polite">
      {status.state === 'sending' && <><Loader2 className="size-3.5 animate-spin" aria-hidden /> Sending to {status.to.name} in chat…</>}
      {status.state === 'sent' && <>
        <CheckCircle2 className="size-3.5 text-success" aria-hidden /> Sent to {status.to.name} in chat
        {status.conversationId && <><span aria-hidden>·</span><button type="button" className={link} onClick={() => onOpen(status.conversationId!)}>Open chat</button></>}
      </>}
      {status.state === 'failed' && <>
        <AlertCircle className="size-3.5 text-danger" aria-hidden /> <span className="text-danger">Couldn't send in chat</span>
        <span aria-hidden>·</span><button type="button" className={link} onClick={onRetry}>Retry</button>
      </>}
    </p>
  )
}
