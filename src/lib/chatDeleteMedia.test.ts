// "Delete for everyone" finds the photo / file a message carries.
import { describe, it, expect } from 'vitest'
import { chatFileUrls } from './chatDeleteMedia'

const U = 'https://x.supabase.co/storage/v1/object/public/attachments/chat/c1/1_a.jpg#w=10&h=10'

describe('chatFileUrls', () => {
  it('finds encrypted and plain photo / file markers', () => {
    expect(chatFileUrls(`[IMAGE-E:v2.a.b.c.d.e](${U})\ncaption`)).toEqual([U])
    expect(chatFileUrls(`[IMAGE](${U})`)).toEqual([U])
    expect(chatFileUrls(`[FILE-E:report%20.pdf:v2.a.b.c.d.e](${U})`)).toEqual([U])
    expect(chatFileUrls(`[FILE:notes.txt](${U})`)).toEqual([U])
  })
  it('ignores plain text and ordinary links', () => {
    expect(chatFileUrls('hello [there](https://example.com)')).toEqual([])
    expect(chatFileUrls('just text')).toEqual([])
  })
})
