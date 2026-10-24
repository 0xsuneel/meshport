# Circle user-controlled wallets

MeshPort is moving every wallet to Circle user-controlled wallets: EOA
accounts on Arc testnet (`ARC-TESTNET`), users paying gas in USDC.

| | |
|---|---|
| Sign in to MeshPort | as today (Supabase) |
| Sign in to the wallet | Circle's own Google login or email OTP, in Circle's Web SDK |
| Approve a transaction | MeshPort passcode / biometric first, then Circle's confirmation UI (kept on) |
| Keys | Circle (2-of-2 MPC, both nodes Circle-hosted); MeshPort never sees keys, PINs or OTPs |

## Backend

- `server/circle/client.ts` - Circle API client; the API key stays server-side,
  a user's Circle session travels as `X-User-Token`.
- `server/circle/service.ts` - one MeshPort account ↔ one Circle user. Every
  call checks the Circle session belongs to the account's linked Circle user;
  the wallet acted on comes from that link, never from the request. Email OTP
  always goes to the MeshPort account's own email. Transfers keep a client
  idempotency key so a retry never sends twice.
- `api/circle-wallet.ts` - the HTTP endpoint (actions listed at the top).
- `supabase/migrations/20261025100000_circle_wallet_users.sql` - the link table
  (service role only). Not applied yet.

## Flow

1. App gets a device token (`social-device-token` / `email-device-token`),
   then Circle's Web SDK logs the user in → `userToken`, `encryptionKey`.
2. `link` ties that Circle user to the MeshPort account (first time).
3. First use: `initialize` → challenge → Circle's SDK `execute(challengeId)`
   creates the Arc wallet; `wallet` then finds and remembers it.
4. Pay: MeshPort passcode / biometric → `transfer` → challenge → Circle's
   confirmation → `challenge` / `transaction` for status.

## Configuration

| Where | What |
|---|---|
| Circle Console | Standard API key (testnet); App ID (Wallets → User Controlled → Configurator); Google OAuth client ID; SMTP for email OTP; confirmation UI on |
| Vercel (app) | `CIRCLE_API_KEY` (set by the owner, never shared in chat); `VITE_CIRCLE_APP_ID` |
| Supabase | Apply the migration above |
