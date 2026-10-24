# Circle user-controlled wallets

New MeshPort accounts made with Google get a Circle user-controlled wallet as
their MeshPort wallet: a generic EVM EOA (`EVM-TESTNET`, the same address on
every EVM chain, Arc included). Circle signs; MeshPort broadcasts through its
own relay, exactly like the app's other wallets. Existing accounts keep their
wallet until they are moved over (a separate, approved plan).

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

- `src/wallet/circle.ts` - sign-in, the Circle session per MeshPort account
  (refreshed once on expiry), `ensureCircleWallet`, and `circleAccount`: a
  `WalletAccount` whose signatures are Circle challenges run headless in the
  SDK. Pay, Swap, Bridge, P2P use it like any wallet.
- `src/features/auth/AutoWalletPage.tsx` - new Google accounts get the Circle
  wallet (`walletSource: 'circle'`).
- `src/features/auth/AuthPages.tsx` - returning accounts whose wallet is their
  Circle wallet open with the Circle signer.
- `src/lib/restoreWallet.ts` - after a reload a Circle wallet reopens from the
  Circle session.
- `src/features/profile/CircleWalletPage.tsx` - Profile → Circle wallet: status,
  Circle sign-in on this device, sign out; and the Google return page.
- `vercel.json` CSP allows Circle's frame, `https://pw-auth.circle.com`.

## Configuration

| Where | What |
|---|---|
| Circle Console (Testnet) | Standard API key; App ID; Google Client ID under Social Logins; Confirmation UIs **off**; SMTP when email accounts move over |
| Vercel (app) | `CIRCLE_API_KEY` (set by the owner, never shared in chat); `VITE_CIRCLE_APP_ID`; `VITE_CIRCLE_GOOGLE_CLIENT_ID` |
| Google OAuth client | The Supabase client; redirect URI `https://meshport.xyz/wallet/circle-login` |
| Supabase | Google provider with that client ID (ID-token sign-in); both migrations above |
