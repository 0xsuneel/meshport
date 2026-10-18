/**
 * ShareChannels — WhatsApp / SMS / Email buttons for a receipt or payment
 * link. Each opens that app's composer with the text filled in; the person
 * picks who to send it to (MeshPort never looks up a phone or email).
 */
import { MessageCircle, MessageSquare, Mail } from 'lucide-react'
import { shareChannels } from '@/lib/shareLinks'

const ICON = { whatsapp: MessageCircle, sms: MessageSquare, email: Mail } as const

export function ShareChannels({ subject, text, className = '' }: { subject: string; text: string; className?: string }) {
  return (
    <div className={`grid grid-cols-3 gap-2 w-full ${className}`}>
      {shareChannels(subject, text).map(c => {
        const Icon = ICON[c.id]
        return (
          <a key={c.id} href={c.href} target={c.id === 'whatsapp' ? '_blank' : undefined} rel="noreferrer"
            className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-2xl border border-border bg-card text-[13px] font-semibold text-text-primary active:bg-border/30">
            <Icon className="size-4 text-brand-text" /> {c.label}
          </a>
        )
      })}
    </div>
  )
}
