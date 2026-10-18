import { describe, it, expect } from 'vitest'
import { whatsappUrl, smsUrl, mailtoUrl, shareChannels } from './shareLinks'

describe('share links', () => {
  const text = 'Chai Corner: bill #00012 for $5.00 & tip\nhttps://meshport.xyz/paylink/r/abc'
  it('encodes the message for each app', () => {
    expect(whatsappUrl(text)).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`)
    expect(smsUrl(text)).toBe(`sms:?&body=${encodeURIComponent(text)}`)
    expect(mailtoUrl('Bill #00012', text)).toBe(`mailto:?subject=Bill%20%2300012&body=${encodeURIComponent(text)}`)
    expect(whatsappUrl(text)).not.toContain('&tip')
  })
  it('lists WhatsApp, SMS and Email', () => {
    expect(shareChannels('s', 't').map(c => c.id)).toEqual(['whatsapp', 'sms', 'email'])
  })
})
