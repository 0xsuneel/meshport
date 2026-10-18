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

/** The three channels for one message. */
export function shareChannels(subject: string, text: string): ShareChannel[] {
  return [
    { id: 'whatsapp', label: 'WhatsApp', href: whatsappUrl(text) },
    { id: 'sms', label: 'SMS', href: smsUrl(text) },
    { id: 'email', label: 'Email', href: mailtoUrl(subject, text) },
  ]
}
