// Share a receipt or a payment link through WhatsApp, SMS or email: each
// opens the app's own composer with the text filled in. MeshPort never
// looks up the customer's phone or email - they pick who to send it to.

/** WhatsApp (app on phones, WhatsApp Web on desktop). */
export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`

/** SMS composer. `?&body=` works on both iOS and Android. */
export const smsUrl = (text: string) => `sms:?&body=${encodeURIComponent(text)}`

/** Email composer. */
export const mailtoUrl = (subject: string, body: string) =>
  `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

export type ShareChannel = { id: 'whatsapp' | 'sms' | 'email'; label: string; href: string }

/** A phone number (digits, with its country code) or an email, as typed. */
export function contactOf(raw: string | null | undefined): { phone?: string; email?: string } {
  const v = (raw ?? '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { email: v }
  const digits = v.replace(/[^\d]/g, '')
  return digits.length >= 7 && digits.length <= 15 ? { phone: digits } : {}
}

/** The three channels for one message - addressed to the person when their
 *  phone or email is known (someone billed who isn't on MeshPort). */
export function shareChannels(subject: string, text: string, to?: string | null): ShareChannel[] {
  const c = contactOf(to)
  const t = encodeURIComponent(text)
  return [
    { id: 'whatsapp', label: 'WhatsApp', href: c.phone ? `https://wa.me/${c.phone}?text=${t}` : whatsappUrl(text) },
    { id: 'sms', label: 'SMS', href: c.phone ? `sms:+${c.phone}?&body=${t}` : smsUrl(text) },
    { id: 'email', label: 'Email', href: c.email ? `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(subject)}&body=${t}` : mailtoUrl(subject, text) },
  ]
}
