# Self-custodial wallets

Every MeshPort wallet is self-custodial. The wallet key is generated on your
device and MeshPort's servers never receive it. On the device it lives only in
the **wallet frame**: a separate origin (`wallet.meshport.xyz`) that the app
talks to but can't read. See [WALLET_FRAME.md](WALLET_FRAME.md).

| Option | Where the key is made | How you open it on another device |
|---|---|---|
| Create wallet | Your device (12-word phrase) | Import the phrase or the private key |
| Import wallet | Already yours | Import the phrase or the private key |

MeshPort works like importing a wallet into MetaMask: the same phrase or key
gives you the same wallet and the same account on any device.

## How it works

1. **Create or import** (`/auth/create-wallet`, `/auth/import-wallet`). The key
   is made or entered inside the wallet frame (`src/wallet`).
2. **Set a 6-digit passcode** (`PasscodeSetup.tsx`). The passcode encrypts the
   key at rest in the frame (PBKDF2-SHA256, 600k rounds → AES-256-GCM, then
   sealed again with the frame's non-extractable device key). Guessing is
   limited inside the frame: 5 free tries, then a lockout that doubles up to
   1 hour.
3. **Optional biometric unlock.** Fingerprint / Face ID can open the passcode
   using the WebAuthn PRF extension (see [BIOMETRIC_PRF.md](BIOMETRIC_PRF.md)).
   The passcode always works without it.
4. **Sign in to MeshPort's server with the wallet itself**
   (`supabase/functions/wallet-login`). The app signs a short message in the
   wallet frame and the server checks the signature. Only the signature leaves
   the device, never the key or the passcode.

## What MeshPort stores

| Stored | Not stored |
|---|---|
| Wallet address, username, profile | Private keys, seed phrases |
| Public account data (chats, activity, rewards) | Your passcode, decrypted keys |

## If things go wrong

- **Lost phone** — import your recovery phrase or private key on the new one.
- **Lost phrase and key** — the wallet cannot be recovered, by you or by
  MeshPort. That is the trade-off of self-custody, so write down your recovery
  phrase and keep it somewhere safe.
- **Forgot the passcode** — it only unlocks this device. Import the wallet
  again with your phrase or private key.

## App lock

The 6-digit passcode (and optional biometric unlock) gates the app and every
payment on the device.
