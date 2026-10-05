# Encrypted chat

Messages, photos and files in MeshPort chats are end-to-end encrypted. The
server relays and stores ciphertext only. Source: `src/lib/chatCrypto.ts`.

## Identity

- Each person has one chat identity: an **X25519** key pair derived from their
  wallet key. Any device that opens the wallet has the same identity, so the
  whole history is readable there.
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

## Trade-off

Chat follows the wallet rather than each device. That is what lets any device
you sign in on read old messages — and it means whoever holds the wallet key
can read that wallet's chats, just as they can move its funds.
