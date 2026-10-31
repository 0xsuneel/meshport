# Circle user-controlled wallets

**Status: off for new accounts.** New Google / email accounts get a Privy
wallet (`src/features/auth/AutoWalletPage.tsx`). MeshPort's Google sign-in
goes through Circle only with `VITE_CIRCLE_WALLETS_ENABLED=true`
(`circleSignInForNewAccounts`), whatever other Circle variables are set.
Accounts whose wallet already is a Circle wallet keep working.

A Circle wallet is a user-controlled, generic EVM EOA (`EVM-TESTNET`, the same
address on every EVM chain, Arc included). Circle signs; MeshPort broadcasts
through its own relay, exactly like the app's other wallets.

| | |
|---|---|
| Sign in | MeshPort's "Continue with Google": one Google screen signs in to MeshPort (Supabase `signInWithIdToken`) and the Circle wallet (Circle's Web SDK) |
| Approve a signature | MeshPort passcode / biometric only; Circle's Confirmation UIs are off (Configurator → Wallet Security Settings), and the Circle wallet screen tells users so |
| Keys | Circle (MPC, Circle-hosted); MeshPort never sees keys or codes |
| Email accounts | Keep the frame wallet for now; Circle's email codes need SMTP in Circle Console |

## One Google sign-in for both

MeshPort builds the Google request itself (`startGoogleSignIn`,
`src/wallet/circle.ts`) with a one-time nonce: Google gets `sha256(raw)`,
Supabase gets `raw` (it checks the hash), and Circle's SDK finds the hashed
value where it keeps its own (`localStorage` `state` / `nonce` /
`socialLoginProvider` - `@circle-fin/w3s-pw-web-sdk` 1.1.11, pinned). Google
returns to `/wallet/circle-login`, which signs in to Supabase, lets the SDK
check the same token with Circle, links the Circle user, and continues at
`/auth/google` as before. Supabase's own URL detection skips that page
(`detectSessionInUrl` in `src/lib/supabase.ts`). If MeshPort can't use the
token, the page falls back to the classic Supabase Google sign-in; if only
Circle fails, the MeshPort sign-in still goes on and the wallet asks again.

## Backend

- `server/circle/client.ts` - Circle API client; the API key stays server-side,
  a user's Circle session travels as `X-User-Token`.
- `server/circle/service.ts` - one MeshPort account ↔ one Circle user. Every
  call checks the Circle session belongs to the account's linked Circle user;
  the wallet acted on comes from that link, never from the request. Signs
  EIP-1559 transactions (legacy `gasPrice` becomes both fees), messages and
  typed data. Email codes always go to the MeshPort account's own email.
- `api/circle-wallet.ts` - the HTTP endpoint (actions listed at the top).
  `social-device-token` starts a sign-in, so it needs no MeshPort session
  (10 a minute per IP); everything else does.
- `supabase/migrations/20261025100000_circle_wallet_users.sql`,
  `20261025110000_circle_wallet_users_blockchain.sql` - the link table
  (service role only) and which chain code the remembered wallet is on.

## App

- `src/wallet/circle.ts` - sign-in, the Circle session per MeshPort account,
  and `circleAccount`: a `WalletAccount` whose signatures are Circle
  challenges run headless in the SDK. Pay, Swap, Bridge, P2P use it like any
  wallet (through `lib/paymentReadiness.ts`).
- `src/features/auth/AuthPages.tsx` - returning accounts whose wallet is their
  Circle wallet open with the Circle signer.
- `src/lib/restoreWallet.ts` - after a reload a Circle wallet reopens from the
  Circle session.
- `src/features/profile/CircleWalletPage.tsx` - Profile → Circle wallet: status,
  Circle sign-in on this device, sign out; and the Google return page.
- `vercel.json` CSP allows Circle's frame, `https://pw-auth.circle.com`.

## Session, readiness and speed

- **Session:** Circle's userToken lasts 60 minutes, and one that expires
  unrefreshed logs the user out. It is refreshed when under 10 minutes are
  left (`freshCircleSession`): before every call, every 5 minutes while the
  app is open, and on return to the app. The expiry comes from the token's
  JWT `exp`, else from when it was issued (`obtainedAt`). A refresh that fails
  for a network reason keeps a still-valid session; Circle refusing it ends
  the session.
- **Readiness:** like Privy's. A Circle signer is `wallet_discovered` until
  `warmCircleSigner` has refreshed the session if due, asked the backend for
  the wallet (session + link check, wakes the function) and loaded the SDK and
  Circle's frame; then `signer_ready` (`lib/walletReadiness.ts`).
- **Per signature:** the endpoint remembers a Supabase-confirmed caller for
  60 s and the service the account's link for 5 min, per warm instance, so a
  signature is one call to MeshPort's function and one to Circle, then the
  SDK. A session error from the SDK (155103/155104/155105) refreshes and signs
  again once with a new challenge; requests time out (20 s backend, 30 s
  challenge) instead of holding a payment screen.

What can't be made Privy-fast on the web: a new device (or cleared storage)
needs its own Circle sign-in - Circle's user wallets can't use MeshPort's
sign-in the way Privy does - and the SDK reloads Circle's page
(`pw-auth.circle.com`) for every signature (`execute` → `appendIframe` sets
`iframe.src`). The session tokens are in `localStorage`, readable by any
script running in the page.

The sign-in writes the SDK's private `localStorage` keys; the SDK is pinned to
1.1.11 and `src/wallet/circleSdkContract.test.ts` fails if an upgrade changes
what it reads.

## Configuration

| Where | What |
|---|---|
| Circle Console (Testnet) | Standard API key; App ID; Google Client ID under Social Logins; Confirmation UIs **off**; SMTP when email accounts move over |
| Vercel (app) | `CIRCLE_API_KEY` (set by the owner, never shared in chat); `VITE_CIRCLE_APP_ID`; `VITE_CIRCLE_GOOGLE_CLIENT_ID`; `VITE_CIRCLE_WALLETS_ENABLED=true` only to switch Circle sign-in on for new accounts (unset = off) |
| Google OAuth client | The Supabase client; redirect URI `https://meshport.xyz/wallet/circle-login` |
| Supabase | Google provider with that client ID (ID-token sign-in); both migrations above |
