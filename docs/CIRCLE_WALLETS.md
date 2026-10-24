# Circle user-controlled wallets

MeshPort is moving every wallet to Circle user-controlled wallets: EOA
accounts on Arc testnet (`ARC-TESTNET`), users paying gas in USDC.

| | |
|---|---|
| Sign in to MeshPort | as today (Supabase) |
| Sign in to the wallet | Circle's own Google login or email OTP, in Circle's Web SDK |
| Approve a transaction | MeshPort passcode / biometric only; Circle's confirmation UIs are off (Configurator → Wallet Security Settings), and the screen tells users so |
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

## App

- `src/wallet/circle.ts` - Circle's Web SDK (loaded only on Circle screens),
  the Circle session per MeshPort account (refreshed once on expiry), Google
  and email-code sign-in, and running challenges.
- `src/features/profile/CircleWalletPage.tsx` - Profile → Circle wallet
  (testnet): sign in, create the wallet, send a test payment (MeshPort
  passcode / biometric, then Circle's confirmation). Also the page Google
  returns to, `/wallet/circle-login`, kept outside the app's gates so the
  sign-in result in the URL isn't lost.
- `vercel.json` CSP allows Circle's frame, `https://pw-auth.circle.com`.

## Flow

1. App gets a device token (`social-device-token` / `email-device-token`),
   then Circle's Web SDK logs the user in → `userToken`, `encryptionKey`.
2. `link` ties that Circle user to the MeshPort account (first time).
3. First use: `initialize` → challenge → Circle's SDK `execute(challengeId)`
   creates the Arc wallet; `wallet` then finds and remembers it.
4. Pay: MeshPort passcode / biometric → `transfer` → challenge (no Circle
   screen) → `challenge` / `transaction` for status.

## Configuration

| Where | What |
|---|---|
| Circle Console | Standard API key (testnet); App ID (Wallets → User Controlled → Configurator); Google OAuth client ID; SMTP for email OTP; Confirmation UIs off |
| Vercel (app) | `CIRCLE_API_KEY` (set by the owner, never shared in chat); `VITE_CIRCLE_APP_ID`; `VITE_CIRCLE_GOOGLE_CLIENT_ID` |
| Google OAuth client | Authorized redirect URI `https://meshport.xyz/wallet/circle-login` (same client as Supabase Google sign-in) |
| Supabase | Apply the migration above |
