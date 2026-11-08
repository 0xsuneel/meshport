// "Delete for everyone" for photos and files (like WhatsApp): the message
// turns into "This message was deleted" on both phones, and the file goes
// too - the server copy (if the recipient hadn't downloaded it yet) and the
// copy saved on each phone. Messages are sealed, so the file's address is
// read by opening the message with this phone's chat key.

/** The chat file addresses in a message's plain text (photo / file markers). */
export function chatFileUrls(plain: string): string[] {
  const out: string[] = []
  for (const m of plain.matchAll(/\[(?:IMAGE(?:-E:[^\]]*)?|FILE(?:-E)?:[^\]]*)\]\(([^)\s]+)\)/g)) out.push(m[1])
  return out
}

/**
 * Forgets the files carried by these messages (sealed contents) of the chat
 * with `otherUserId`: on this phone and on the server. Best-effort - a
 * message this phone can't open is skipped.
 */
export async function forgetFilesOf(contents: string[], otherUserId: string | null | undefined): Promise<void> {
  const sealed = contents.filter(c => typeof c === 'string' && c && c !== '[deleted]')
  if (!sealed.length) return
  try {
    const [{ useAuthStore }, crypto, media] = await Promise.all([
      import('@/store'), import('./chatCrypto'), import('@/features/chat/chatMediaStore'),
    ])
    const wallet = useAuthStore.getState().walletAddress
    const keys = wallet && otherUserId ? await crypto.getConversationKey(wallet, otherUserId).catch(() => null) : null
    const urls = new Set<string>()
    for (const c of sealed) {
      const plain = crypto.isEncryptedPayload(c) ? (keys ? await crypto.decryptText(c, keys) : '') : c
      for (const u of chatFileUrls(plain)) urls.add(u)
    }
    await Promise.all([...urls].map(u => media.forgetChatFile(u, { server: true })))
  } catch (e) {
    console.warn('[chat] removing deleted files failed:', e instanceof Error ? e.message : e)
  }
}
