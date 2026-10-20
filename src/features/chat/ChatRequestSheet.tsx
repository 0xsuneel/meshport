// Chat + → Request (USDC only): ask this person for an amount, with an
// optional note. Creates a real payment request (an order) and posts it as
// the live 💸 Payment request card - they pay it right in the chat, and it
// turns Paid for them and Payment received for you.
// The form is shared with Business → Charge (RequestAmountForm): person,
// amount field with quick amounts, keypad (phone), Cancel / Request.
import { ActionSheet, SheetPerson } from '@/components/ui/ActionSheet'
import { RequestAmountForm } from '@/features/merchant/RequestComposer'
import { StorePicker } from '@/features/merchant/StorePicker'

export { cleanRequestAmount } from '@/features/merchant/RequestComposer'

export function ChatRequestSheet({ open, onClose, isDesktop, name, username, avatar, store, onRequest }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  name: string
  username: string
  avatar?: string | null
  /** A business with several stores: which one the request is for. */
  store?: { list: { id: string; name: string }[]; value: string; onChange: (id: string) => void }
  /** Creates the request and posts it; throws with a message to show. */
  onRequest: (amount: number, note: string) => Promise<void>
}) {
  return (
    <ActionSheet open={open} onClose={onClose} isDesktop={isDesktop} id="chat-request">
      <RequestAmountForm open={open} isDesktop={isDesktop} hint="They pay it right here in chat" onCancel={onClose}
        header={compact => <div className="flex flex-col gap-3">
          <SheetPerson label="Request from" name={name} username={username} avatar={avatar} compact={compact} onClose={isDesktop ? onClose : undefined} />
          {!compact && store && store.list.length > 1 && <StorePicker stores={store.list} value={store.value} onChange={store.onChange} />}
        </div>}
        onSubmit={async (amount, note) => { await onRequest(amount, note); onClose() }} />
    </ActionSheet>
  )
}
