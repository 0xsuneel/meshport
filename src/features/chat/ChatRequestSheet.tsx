// Chat + → Request (USDC only): ask this person for an amount, with an
// optional note. Creates a real payment request (an order) and posts it as
// the live 💸 Payment request card - they pay it right in the chat, and it
// turns Paid for them and Payment received for you.
// The form is shared with Business → Charge (RequestAmountForm): person,
// amount field with quick amounts, keypad (phone), Cancel / Request.
import { ActionSheet, SheetPerson } from '@/components/ui/ActionSheet'
import { RequestAmountForm } from '@/features/merchant/RequestComposer'

export { cleanRequestAmount } from '@/features/merchant/RequestComposer'

export function ChatRequestSheet({ open, onClose, isDesktop, name, username, avatar, onRequest }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  name: string
  username: string
  avatar?: string | null
  /** Creates the request and posts it; throws with a message to show. */
  onRequest: (amount: number, note: string) => Promise<void>
}) {
  return (
    <ActionSheet open={open} onClose={onClose} isDesktop={isDesktop} id="chat-request">
      <RequestAmountForm open={open} isDesktop={isDesktop} hint="They pay it right here in chat" onCancel={onClose}
        header={compact => <SheetPerson label="Request from" name={name} username={username} avatar={avatar} compact={compact} onClose={isDesktop ? onClose : undefined} />}
        onSubmit={async (amount, note) => { await onRequest(amount, note); onClose() }} />
    </ActionSheet>
  )
}
