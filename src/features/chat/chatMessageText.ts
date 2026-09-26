// Decrypted chat text, shared by the conversation page and its sheets
// (search, delete dialog, copy, forward). Filled as bubbles decrypt, and by
// the sender with the plaintext of what it just encrypted.
import { isEncryptedPayload } from '@/lib/chatCrypto'

// Decrypted text by ciphertext — shared so search, the delete dialog and a
// bubble re-mounting (optimistic → saved copy) never show ciphertext or flash.
export const _plainByContent = new Map<string, string>()
/** decryptText's "🔒 Encrypted message — unable to decrypt…" placeholder. */
export const isDecryptFailure = (s: string) => s.startsWith('🔒 Encrypted message')
export function plainTextOf(content: string): string {
  if (!content) return ''
  if (!isEncryptedPayload(content)) return content
  return _plainByContent.get(content) ?? ''
}

/**
 * A photo / file message is its marker on the first line, optionally followed
 * by a caption: "[IMAGE-E:iv](url)\nNice view". Anything else → no media.
 */
export function splitCaption(plain: string): { media: string; caption: string } {
  if (!plain.startsWith('[IMAGE') && !plain.startsWith('[FILE')) return { media: plain, caption: '' }
  const nl = plain.indexOf('\n')
  return nl < 0 ? { media: plain, caption: '' } : { media: plain.slice(0, nl), caption: plain.slice(nl + 1).trim() }
}

/** One-line preview of a message (decrypted): "Photo", "📎 name", or its text. */
export function messagePreview(content: string): string {
  const t = plainTextOf(content)
  if (!t) return 'Message'
  const { media, caption } = splitCaption(t)
  if (media.startsWith('[IMAGE') ) return caption ? `Photo · ${caption}` : 'Photo'
  const f = /^\[FILE(?:-E)?:(.+?)(?::[^:\]]+)?\]\(/.exec(media)
  if (f) { let n = f[1]; try { n = decodeURIComponent(n) } catch { /* plain */ } return caption ? `File · ${caption}` : `File · ${n}` }
  return t
}

/** A photo / file message's parts (from its decrypted text), or null for text. */
export function parseMedia(plain: string): { kind: 'image' | 'file'; encrypted: boolean; iv: string | null; url: string; name: string; caption: string } | null {
  const { media, caption } = splitCaption(plain)
  let m = /^\[IMAGE-E:(.+?)\]\((.+)\)$/.exec(media)
  if (m) return { kind: 'image', encrypted: true, iv: m[1], url: m[2], name: 'photo.jpg', caption }
  m = /^\[IMAGE\]\((.+)\)$/.exec(media)
  if (m) return { kind: 'image', encrypted: false, iv: null, url: m[1], name: 'photo.jpg', caption }
  m = /^\[FILE-E:(.+):([^:\]]+)\]\((.+)\)$/.exec(media)
  if (m) { let n = m[1]; try { n = decodeURIComponent(n) } catch { /* plain */ } return { kind: 'file', encrypted: true, iv: m[2], url: m[3], name: n, caption } }
  m = /^\[FILE:(.+?)\]\((.+)\)$/.exec(media)
  if (m) { let n = m[1]; try { n = decodeURIComponent(n) } catch { /* plain */ } return { kind: 'file', encrypted: false, iv: null, url: m[2], name: n, caption } }
  return null
}
