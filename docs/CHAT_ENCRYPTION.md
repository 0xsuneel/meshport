# Encrypted chat

Messages, photos and files in MeshPort chats are end-to-end encrypted. The
server only relays ciphertext: each message or file is deleted from it once
the other person's phone has it, or after 30 days if never delivered
(`chat-expiry`). Payment cards are the exception - they stay, so payment
history shows on every device. Source: `src/lib/chatCrypto.ts`,
`src/lib/chatWrap.ts`, `wallet-frame/src/main.ts` (`chat:*`).

## Identity

- Each person has one chat identity: an **X25519** key pair derived from their
  wallet key, inside the wallet frame. The private key never leaves the frame:
  the app asks the frame to seal and open each message's own key.
- Any device that opens the wallet has the same identity, so new messages
  open there. Old messages don't come back: chats live only on the phone
  (no backup, like WhatsApp without a chat backup).
- Only the **public** key is published (`users.chat_public_key`), together with
  a **signature by the wallet** over it (`users.chat_key_sig`).
- A key is used only if its signature recovers to that user's wallet address.
  A key swapped in the database without the wallet's signature is ignored.
- Each device also remembers every contact's wallet + key the first time it
  sees them. If either changes, the app shows a security notice and holds
  messages and Pay until you confirm.

## Messages (`e2e:v2`)

```
fresh random key K ── AES-256-GCM ──► message / photo / file
K ── sealed with HKDF-SHA256(X25519(sender, recipient)) ──► for both people
```

Every message gets its own key, so one leaked key opens one message only. The
message names both public keys, so reading it never depends on a server
lookup.

## Recipient without a key yet (`e2e:q2`)

If the other person hasn't published a key, the message is sealed for the
sender only — never sent readable. When their key appears, the sender's app
re-seals it for both.

## Delete for everyone

Like WhatsApp: the message becomes "This message was deleted" on both phones,
and its photo or file is removed from the server and from both phones.

## Trade-off

The chat key follows the wallet rather than each device, and there is no
forward secrecy: whoever holds the wallet key can open that wallet's
messages (those on its phone, or sealed copies someone saved off the
server), just as they can move its funds.
