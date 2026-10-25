# Privy wallets

New Google and email MeshPort accounts get a Privy embedded wallet. Privy
keeps the key split in its secure hardware (AWS Nitro enclaves) and signs only
for requests the signed-in user authorizes; a new device needs nothing but the
MeshPort sign-in. Existing accounts keep their wallet until they are moved
over (a separate, approved plan). Circle user-controlled wallets are switched
off (their two `VITE_CIRCLE_*` settings are removed).

| | |
|---|---|
| Sign in | MeshPort's own Supabase sign-in; Privy accepts its JWT (custom auth), so there is one sign-in |
| Approve a signature | MeshPort passcode / biometric; Privy's confirmation modals are off (`showWalletUIs: false`) |
| Send | Privy signs; MeshPort broadcasts through its own relay (Arc as a custom chain) |
| Who loads Privy | Only signed-in Google / email accounts (`PrivyGate`); anonymous sessions and visitors never download it |

## Code

- `src/wallet/privy.ts` - the bridge, `ensurePrivyWallet`, `restorePrivyAccount`
  and `privyAccount` (a `WalletAccount`, used like any wallet).
- `src/wallet/PrivyRoot.tsx` - Privy's provider and hooks, syncing Privy with
  the Supabase session (`useSubscribeToJwtAuthWithFlag`).
- `src/wallet/PrivyGate.tsx` - loads `PrivyRoot` only when needed.
- `src/features/auth/AutoWalletPage.tsx` - new Google / email accounts get the
  Privy wallet (`walletSource: 'privy'`); if Privy can't open one, the frame
  wallet instead, with the reason in `client_errors`.
- `src/features/auth/AuthPages.tsx` - returning accounts whose wallet is their
  Privy wallet open with it; `src/lib/restoreWallet.ts` reopens it after a reload.
- `vercel.json` - CSP `frame-src` allows `https://auth.privy.io`.

## Configuration

| Where | What |
|---|---|
| Privy dashboard | App ID; Custom authentication approved; JWT integration: client-side, JWKS `https://cvvpzfvzweszuuxvaayb.supabase.co/auth/v1/.well-known/jwks.json`, ID claim `sub`; Ethereum embedded wallets; allowed domains meshport.xyz, www.meshport.xyz, localhost:5173 |
| Vercel (app) | `VITE_PRIVY_APP_ID` |
| Supabase | Asymmetric JWT signing keys (ES256, already on) |

`@privy-io/react-auth` is pinned at 3.48.1, which pins viem 2.56.5 for the
whole app.
