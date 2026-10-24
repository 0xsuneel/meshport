# Self-custodial wallets

Every MeshPort wallet is self-custodial. However you sign in, the wallet key is
generated on your device, and MeshPort's servers never receive it. On the device
it lives only in the **wallet frame**: a separate origin (`wallet.meshport.xyz`)
that the app talks to but can't read. See [WALLET_FRAME.md](WALLET_FRAME.md).

| Sign-in | Where the key is made | How another device opens it |
|---|---|---|
| Create wallet | Your device (12-word phrase) | The phrase or the private key |
| Import wallet | Already yours | The phrase or the private key |
| Google / email code | Your device | A passkey, or the Recovery QR + its password |

## Google and email accounts

```
 sign in ──► key generated in the wallet frame ──► sealed on this device (frame's device key)
                                      ├─► passkey   (Face ID / fingerprint, synced by your OS)
                                      └─► Recovery QR (password only you know)
```

1. **Sign in.** Google or a one-time email code proves who you are to Supabase
   Auth. That identifies the account; it does not open the wallet.
2. **The key is created on the device**, inside the wallet frame
   (`createWallet('social-auto')`, `src/wallet`).
3. **This device keeps a sealed copy** in the frame's storage, encrypted with a
   non-extractable AES key that belongs to the frame's origin
   (`wallet-frame/src/vault.ts`), so reloads open the wallet straight away.
   Logout deletes it.
4. **Secure it** (`/auth/secure-wallet`):
   - **Passkey** — the WebAuthn PRF extension gives a secret that only your
     passkey can produce after Face ID / fingerprint. The key is wrapped with
     `HKDF-SHA256(PRF) → AES-256-GCM` inside the frame (`src/lib/passkeyWrap.ts`;
     the ceremony is `src/lib/walletPasskey.ts`). The server stores only the
     credential id, the PRF salt and the ciphertext.
   - **Recovery QR** — the key is sealed with a password you choose:
     `Argon2id (32 MiB, t=2, p=1) → AES-256-GCM`, with the whole header
     authenticated (`src/lib/recoveryQr.ts`, run inside the frame). The QR is printed as
     `meshport-recovery:…`. MeshPort keeps only the date you made it.
5. **New device.** After sign-in, the app asks for your passkey or your
   Recovery QR (`/auth/recover-wallet`); the frame opens it and checks that the
   key matches the account's wallet address before using it.

## What MeshPort stores

| Stored | Not stored |
|---|---|
| Wallet address, username, profile | Private keys, seed phrases |
| Passkey credential id, PRF salt, passkey-wrapped key | PRF secrets, decrypted keys |
| Date a Recovery QR was made | Recovery passwords, QR contents |

The old server-held wallet vault (`wallet-key` Edge Function) is retired and
answers `410 Gone`.

## If things go wrong

- **Lost phone** — sign in on the new one and use a synced passkey, or scan
  the Recovery QR and type its password.
- **Lost passkey and Recovery QR** — the wallet cannot be recovered, by you or
  by MeshPort. That is the trade-off of self-custody, so save the Recovery QR.
- **Someone finds your Recovery QR** — without the password it's useless;
  Argon2id makes guessing slow. Make a new one from Security if you're unsure.

## App lock

Separately from the wallet key, a 6-digit passcode (and optional biometric
unlock) gates the app and every payment on the device.
