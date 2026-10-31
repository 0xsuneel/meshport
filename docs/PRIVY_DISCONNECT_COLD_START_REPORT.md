# Privy disconnects at sign-in and on cold starts

Date: 2026-10-31. Method: read MeshPort's Privy code (`src/wallet/*`,
`restoreWallet.ts`, sign-in screens) and the source of the pinned SDKs
(`@privy-io/react-auth` 3.48.1, `@supabase/auth-js`) to see exactly what each
does on failure. Nothing was run against a real account, so the causes below
are established from the libraries' code, not from a captured session.

## What was already handled

The previous rounds covered a stuck wallet iframe, Privy that never loaded,
a stale iframe after a long background, warm-up signing and rebuild pacing.
Those are sound and were left alone.

## What was still wrong

### 1. Privy's sync signs Privy out on any failure and never tries again

MeshPort signs in to Privy with its own Supabase token (custom auth) through
`useSubscribeToJwtAuthWithFlag`. In the SDK's sync (`useSyncJwtBasedAuthState`):

| Situation | What Privy does |
|---|---|
| The app's token getter returns nothing while Privy is signed in | `logout()` |
| Anything throws while authenticating with the token (a dropped request) | `logout()`, status `error` |
| Privy logged itself out, then sees the same token again | Skips the sync ("same token"), stays signed out |
| After any of these | Sync runs again only when Privy's signed-in flag, or the app's `isAuthenticated` / `isLoading`, changes |

MeshPort ignored the hook's status, so after one failed attempt Privy stayed
`ready=true authenticated=false` for the rest of the page's life. Nothing
counted that as "needs a rebuild" (`privyNeedsRebuild` only looked at a
signed-in Privy with no wallet). The visible result: sign-in or a resume
showed "Your wallet didn't open" / "Couldn't set up your wallet", and
**Try Again waited on the same dead Privy** until a reload. This matches the
31 Oct field note that the wallet was "gone until the app was restarted".

### 2. The token getter answered "no token" when Supabase could not refresh

The getter was `(await supabase.auth.getSession()).data.session?.access_token`.
When the stored access token has expired (about an hour) and the refresh
request fails, `getSession()` returns `session: null` **with an error**. That
is exactly a phone resuming with no connection yet, or a Privy rebuild on a
weak network. The getter returned `undefined`, so Privy signed itself out
(row 1 of the table). The rebuilds PrivyRoot does on weak connections made
this worse: each new Privy asked for the token at once.

A replaced (rebuilt) Privy could also finish its pending token request late,
see no token and log out the session its replacement now shares.

### 3. A transient "no session" unmounted Privy

`useSupabaseSession` treated any `null` session from any auth event as signed
out, and `PrivyGate` unmounts Privy when there is no session. A refresh that
failed offline at start (or any null that was not a real `SIGNED_OUT`) tore
Privy down and left it down until a later event.

### 4. Cold start: the first connection to Privy was opened late

`index.html` opens no early connection to Privy. For a returning Privy
account the first DNS, TCP and TLS setup to `auth.privy.io` happened only
after the app code ran and Privy's iframe was created. The Privy code itself
was already prefetched in `main.tsx` (about 324 KB gzipped).

## Fixes

| File | Change |
|---|---|
| `src/wallet/privyJwt.ts` (new) | `createJwtProvider`: the token getter waits and retries (1, 2, 4, 8, then 15 s, or at once on `online` / back on screen) while the session exists but can't be refreshed. It answers "no token" only for a real sign-out. While the refresh fails it hands out the token Privy already has if still valid for 15 s+ (the same token is a no-op for Privy). A replaced Privy's getter never settles, so it can't log out its replacement. Also the pure rules for when to re-sync |
| `src/wallet/PrivyRoot.tsx` | Uses that getter. Reads the sync status: after a failed sync it starts the sync again (2, 5, 10 s) by flipping `isLoading` briefly, immediately when a payment needs the wallet or the connection returns. A Privy that is still signed out after 3 tries, or signed out with no error (the "same token" trap), is rebuilt through the existing rebuild pacing. Failures are reported to `client_errors` as `[privy sync] ...` |
| `src/wallet/privy.ts` | `privyNeedsRebuild` is true for a signed-out Privy whose sync failed; a wallet needed while Privy is signed out now triggers the restart event (it only did when Privy wasn't loaded) |
| `src/wallet/PrivyGate.tsx` | A `null` session that isn't `SIGNED_OUT` keeps the signed-in state; an unreadable session (expired, refresh failed) is read again with backoff and on `online`; the same token no longer re-renders everything |
| `public/boot.js` | Returning Privy accounts open the connection to `auth.privy.io` as the page starts |

Tests: `privyJwt.test.ts` (17) and a case in `privyRebuild.test.ts`. 50 Privy
tests pass. The rest of the wallet folder's failures need packages that are
not installed in this sandbox (`ethers`, the Circle web SDK).

## Not changed

- **Signing out of MeshPort does not sign out of Privy.** `PrivyRoot` just
  unmounts, so Privy's own session stays in the browser. Signing in as someone
  else works (Privy re-authenticates with the new token), but an explicit
  Privy `logout()` on MeshPort sign-out would be cleaner. It needs a change in
  the logout path that I did not want to make blind.
- **Rebuild thresholds** (5 s / 8 s quiet, the 2-then-20/40/60 s pacing) were
  tuned on field data; I left them.
- The slow part of a cold start that remains is Privy's own first wallet
  authentication (20 to 45 s in the field notes), which the warm-up already
  front-loads. It is Privy's server call and can't be shortened from here.

## How to confirm after deploy

In `client_errors`, expect fewer `[privy restore] no wallet after ...` rows
with `authenticated=false`, and watch for the new `[privy sync]` rows: a few
`failed (re-sync #1)` followed by a normal sign-in is the fix working; many
`rebuilding Privy` rows would point to a Privy or JWKS problem on the server
side (check the JWKS URL in the Privy dashboard).
