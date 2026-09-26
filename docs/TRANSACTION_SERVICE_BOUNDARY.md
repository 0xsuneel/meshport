# ADR: Transaction State Machine — Service-Role Boundary

Status: **Decided.** Documentation + location/config checkpoint only — no state-machine
transition logic changed. Pay, Receive, Swap, the indexer, Activity, and `wallet-key` remain
untouched, exactly as scoped.

This resolves the open item flagged at the end of Phase 2
(`docs/TRANSACTION_STATE_MACHINE.md` §9): the state-machine write functions
(`transitionIntent`/`transitionAttempt`/`transitionLedgerEvent`) require a **service-role**
Supabase client, but the module was physically sitting inside `src/lib/` — the tree Vite bundles
into the browser. That was a real, latent risk even though nothing imported it yet: nothing
structurally prevented a future accidental `import` from a React component or Zustand store.

---

## 1. Who may import the state-machine write functions

**Only server-side code that legitimately holds a service-role Supabase client:**

- Vercel serverless functions under `api/` (and their shared helpers under `api/_lib/`).
- Supabase Edge Functions under `supabase/functions/*` (and `supabase/functions/_shared/`).
- Any future purely-server-side worker/reconciler process (Phase 3/4), wherever it ends up
  running, as long as it's not shipped to the browser.

Concretely today: **nothing yet**, by design (Phase 2's own report: no feature calls this
module in production). This ADR defines the rule for when something does.

## 2. Who must NEVER import them

- React components (anything under `src/components/`, `src/features/`).
- Browser-only feature code (`src/lib/*.ts` files that run in the browser — the large majority
  of `src/lib/`, e.g. `p2pService.ts`, `ActivityService.ts`, `arc.ts`, `rewards.ts`).
- Zustand stores (`src/store/*`).
- Any client-side utility, hook, or `src/hooks/*`.
- `api/og-image.tsx`/`api/og-pay.ts` if they ever render client-shared components — treated as
  server code today (they run in Vercel), but flagged because they're the one place in `api/`
  that imports UI-shaped code; they must not become a bridge that pulls browser code into a
  context that also imports the state machine, or vice versa.

**Enforcement done today (see §9)**: the module now physically lives in `server/`, a directory
Vite's build has no path to (§9 verifies this concretely, not just asserts it). This makes "must
never import" a build-time impossibility for the browser bundle, not just a documented
convention that a future PR could silently violate. It does **not** stop someone from adding a
new import statement in `src/` that reaches into `server/` via a relative path — that would
still need to be caught in review. A future addition (not done here — see §10) would be an
ESLint `no-restricted-imports` rule blocking any `src/**` file from importing `server/**`; not
added now because the project currently has **no ESLint config at all** (confirmed in the Phase
2 report — `npm run lint` fails identically on an unmodified checkout), so there is no lint
pipeline to add the rule to yet.

## 3. Where the privileged service-role client is created

**Nowhere new, by this ADR.** The state machine's `apply.ts` never creates a client — every
write function takes the client as a parameter (`transitionIntent(client, intentId, to, ...)`).
This was already true before this pass (Phase 2 built it that way deliberately) and is preserved
unchanged.

Client construction stays with the caller, following the two patterns already proven correct
elsewhere in this codebase:

- **`api/` (Vercel):** `api/transactions.ts` already constructs a service-role-authenticated
  fetch to Supabase's REST endpoint using `process.env.SUPABASE_SERVICE_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` (never a `VITE_`-prefixed variable, which would be bundled into
  the browser — see `api/swap-proxy.js`'s and `api/relay-gas.ts`'s own comments on exactly this
  point). A future `api/` function calling the state machine should construct a real
  `@supabase/supabase-js` `createClient(url, serviceKey)` the same way, reading the key from
  `process.env`, never from anything reachable by the client.
- **`supabase/functions/*` (Deno Edge Functions):** `wallet-key/index.ts` already does exactly
  this correctly — `createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)` using
  `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` (with a documented fallback to
  `SUPABASE_SECRET_KEYS`), never exposed to the function's response. This is the reference
  implementation for "how do do this correctly" — see §8.

## 4. How API routes and Edge Functions call the state machine

**Target shape** (matches the diagram you specified):

```
Frontend
   ↓
Authenticated API / Edge Function   ← verifies the session (§6) BEFORE calling anything below
   ↓
Transaction Service                 ← NEW layer, not built yet — see §9/§10
   ↓
State Machine                       ← server/transactionStateMachine (this ADR's subject)
   ↓
Database
```

The **Transaction Service** layer does not exist yet — it is intentionally not built in this
pass (would be refactoring the implementation, out of scope per your instructions). What this
ADR fixes is the layer *underneath* it (the state machine's location and import boundary) so
that when the Transaction Service layer is built (Phase 3+, whenever a feature or the reconciler
first needs it), there's a safe, unambiguous place for it to live and call into.

Recommended pattern for that future layer, stated now so Phase 3 doesn't have to re-derive it:

- A single `server/transactionService/` (sibling to `server/transactionStateMachine/`) module
  holding feature-facing functions like `createPayIntent(...)`, `recordConfirmedLedgerEvent(...)`
  — each one: (a) verifies auth/authorization itself or receives an already-verified identity
  from its caller (§6/§7), (b) does any feature-specific validation (preflight checks, amount
  parsing into atomic units), (c) calls `transitionIntent`/`transitionAttempt`/
  `transitionLedgerEvent` from `transactionStateMachine`, (d) never exposes the raw Supabase
  client to its own caller.
- `api/*.ts` functions and `supabase/functions/*/index.ts` functions both import from
  `server/transactionService/` (which itself imports `server/transactionStateMachine/`) instead
  of either one calling the state machine directly — this keeps the "verify auth, then call the
  service" shape uniform across both runtimes rather than each reinventing it.
- **Not decided by this ADR**: the exact mechanics of how a Deno Edge Function's build/deploy
  step resolves a relative import that reaches outside `supabase/functions/` into a repo-root
  `server/` directory. `supabase/functions/_shared/` is the only cross-file-sharing pattern
  proven to work in this repo today (every existing Edge Function's shared imports stay inside
  `supabase/functions/`; grepped for and found zero examples reaching further out — see the
  investigation note in §9). Supabase Edge Functions are typically bundled by the Supabase CLI
  from the full local repo checkout at deploy time (the same general approach Vercel uses for
  `api/`), which suggests a relative import into `server/` *should* work the same way `_shared/`
  already does — but this is inferred from how the tooling generally behaves, not verified
  against an actual `supabase functions deploy` in this environment. **Recommendation for
  whoever implements Phase 3's first Edge-Function consumer:** try the direct relative import
  first (e.g. `import { transitionAttempt } from '../../../server/transactionStateMachine/apply.ts'`)
  and deploy it as a smoke test before building anything else on top of it; if it doesn't bundle
  correctly, fall back to mirroring the pure, DB-independent parts of the module
  (`types.ts`/`transitions.ts` — see §9's framework-independence discussion, these have zero
  external dependencies and are the cheapest to duplicate if it ever comes to that) into
  `supabase/functions/_shared/transactionStateMachine/`.

## 5. How the indexer / reconciler will call it

Same shape as §4's second diagram:

```
Indexer / Reconciler
   ↓
Transaction Service
   ↓
State Machine
   ↓
Database
```

The indexer (`supabase/functions/blockchain-indexer/`) is explicitly untouched by this pass (per
your instructions) and remains in shadow mode — it does not call the state machine today and
this ADR does not change that. When it goes authoritative (Phase 3, not this pass), the
recommendation is: the indexer's own Edge Function code calls into `server/transactionService/`
(or directly into `server/transactionStateMachine/` for the narrower reconciler-specific
transitions like resolving an `UNKNOWN` attempt) using the **same** import path and the **same**
service-role client pattern as any `api/` or other Edge Function caller — there is nothing
indexer-specific about how it reaches the state machine. The one indexer-specific detail worth
flagging now: the indexer already has its own idempotent, cursor-based, reorg-aware event model
(`chain_events`, Phase 0/1 audits) — Phase 3/4's job is to translate a confirmed `chain_events`
row into the *correct* state-machine calls (e.g. `transitionLedgerEvent(id, 'POSTED')` once past
confirmation depth), not to reimplement any of the state/reorg logic the state machine already
owns.

## 6. How auth/authorization is verified before creating a transaction intent

**No new mechanism invented here** — this ADR requires the *same* pattern already proven
correct in this codebase, applied consistently, rather than inventing a new one:

`wallet-key/index.ts`'s pattern (Phase 0 audit, §1) is the reference implementation:

1. Read the caller's session JWT from the `Authorization: Bearer ...` header.
2. Call `supabase.auth.getUser(jwt)` **server-side, using the service-role client** — this is
   the actual verification step; it re-validates the token against Supabase Auth rather than
   trusting anything the client claims about its own identity.
3. Resolve `auth.uid()` → `public.users.id` via a server-side lookup (`users.auth_uid = authUid`)
   — **not** the reverse. The client never gets to assert its own `user_id`.
4. Only then perform the privileged operation, scoped to the resolved identity.

Applied to the future `createIntent`-shaped Transaction Service function: it must receive the
raw JWT (not a client-asserted `user_id` or `wallet_address`), perform steps 2–3 itself (or
receive an already-verified identity object from a shared auth-verification helper that does
exactly steps 2–3 — worth extracting into `server/_shared/verifySession.ts` or similar when a
second caller needs it, not built now since there's only the one reference implementation to
generalize from today), and only then call `transitionIntent`/create the row. **A
`transaction_intents.wallet_address` value must never be taken as given from the request body
without being checked against what the verified session is actually allowed to act as** — see
§7 for exactly how "allowed to act as" is determined.

## 7. How wallet ownership is verified for wallet-only users

**This is the one place this ADR has to be honest that the codebase does not yet have a strong
answer, and recommend the same indirect pattern `wallet-key` already relies on rather than
inventing cryptographic proof-of-ownership that doesn't exist here today.**

Current state (confirmed by grep across `src/`, `api/`, `supabase/` for
`verifyMessage`/`verifyTypedData`/`recoverAddress`/SIWE-style patterns): **zero results.** There
is no signature-challenge mechanism anywhere in this codebase proving "the caller controls the
private key for wallet X." Wallet-only users get an **anonymous** Supabase Auth session
(`ensureAnonSession()` in `src/lib/supabase.ts`) purely so RLS's `using(true)` policies have a
JWT to check against — that JWT proves "a session exists," not "this session's owner controls
this wallet."

What **does** work correctly today, and is the pattern to carry forward: `wallet-key` never
accepts a client-supplied `wallet_address` to decide *which* key to operate on — it always
resolves the row via the verified session's own `public.users.id`, so there is no
`wallet_address` parameter for an attacker to substitute in the first place. **Recommendation:**
apply the identical shape to the Transaction Service — an authenticated request creates an
intent for "the wallet(s) belonging to this verified session's `public.users.id`" (looked up
server-side from `users.wallet_address`, the same column `wallet-key` and `checkAccountIsSocial`
already read), never for a `wallet_address` the client puts in the request body. This closes the
exact hole documented as confirmed-P0 in the Phase 0/1 audits for `/api/transactions`
(unauthenticated, wallet-address-only reads/writes) — **not fixed by this ADR** (that's Phase
16's job per the original migration order, and touching `api/transactions.ts` is out of this
pass's scope), but this ADR ensures the *new* Transaction Service is not built with the same
hole from day one.

This is a weaker guarantee than true cryptographic proof of wallet ownership (a signature
challenge the client signs with the wallet's private key, verified server-side by recovering the
signing address) — worth calling out as a real gap, not glossed over. Recommended as a
**future** hardening step (not a Phase 3 blocker): add a sign-in-with-Ethereum-style challenge
for wallet-only flows, verified server-side, so `users.wallet_address` itself is backed by a
cryptographic proof at the time it was linked to the session — rather than *only* being reached
via a session lookup, which stops the "any client can claim any address" problem but does not
independently prove the session's own account genuinely owns that address if the linking step
itself was ever weak. Whether the existing account-linking flow (`AutoWalletPage.tsx`,
`AuthPages.tsx`, `wallet-key`'s `generate-wallet`/`restore-full-key`) already provides this
guarantee by construction (since the private key itself is generated/held server-side for social
accounts, and locally for self-custodial ones, with the address always derived from a key the
app itself controls or generated) is a reasonable follow-up question for whoever owns that flow,
not re-litigated here.

## 8. How service-role credentials remain server-side

Nothing new — restating the existing, already-correct rules this ADR requires the Transaction
Service to keep following:

- **Never** a `VITE_`-prefixed environment variable (Vite inlines every `VITE_*` var into the
  browser bundle at build time — this is explicitly called out in `api/relay-gas.ts` and
  `api/swap-proxy.js`'s own comments as the reason `DRPC_KEY`/`ARC_RPC_URL`/etc. are deliberately
  **not** `VITE_`-prefixed).
- **Never** returned in any API/Edge Function response body, logged, or included in any object
  serialized back to the client — `wallet-key`'s `clientSafeError()` pattern (full detail to
  `console.error` only, a generic message to the client) is the model to follow for anything the
  Transaction Service might need to report back about a failed transition.
- Read only from `process.env.SUPABASE_SERVICE_ROLE_KEY` (Vercel) or
  `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` (Edge Functions) — or their already-documented
  fallbacks (`SUPABASE_SECRET_KEYS` for Deno, per `wallet-key`'s `getServiceRoleKey()`) — at the
  point of client construction in `api/`/`supabase/functions/`, never passed down from anywhere
  else, and never constructed inside `server/transactionStateMachine/` itself (§3).

## 9. Investigation performed for this ADR (not just asserted)

- **Confirmed zero existing references** to the state-machine module from anywhere in `src/`
  before moving it (`grep -rln "transactionStateMachine" src` outside the module's own
  directory returned nothing) — moving it was safe with no call-site updates needed.
- **Moved** `src/lib/transactionStateMachine/` → `server/transactionStateMachine/` (six files,
  content unchanged — verified via the same file names/sizes, only the directory moved).
- **Confirmed Vite has no path to `server/`:** `vite.config.ts`'s `resolve.alias['@']` points
  only at `./src`; the build entry is `index.html` → `src/`; grepped `src/**` for any import
  reaching into `server/` and found none.
- **Added `server/tsconfig.json`**, mirroring `api/tsconfig.json`'s existing isolation pattern
  (its own tsconfig, not included by the root `tsconfig.json`'s `"include": ["src"]`) —
  `npx tsc -p server --noEmit` passes cleanly.
- **Added `npm run typecheck:server`** to `package.json`, since the root `npm run typecheck`
  script (by design, matching how `api/` has never been covered by it either) does not reach
  `server/`.
- **Updated `vitest.config.ts`**'s `test.include` to also pick up `server/**/*.test.ts` — ran
  the full suite from the new location: **180/180 tests still pass** (same count as the Phase 2
  report; nothing regressed by the move).
- **Grepped `supabase/functions/` for any existing cross-directory relative import** (anything
  reaching outside `supabase/functions/` itself) — found none. Every existing Edge Function's
  shared code lives in `supabase/functions/_shared/`. This is the basis for §4's honest
  "not verified, here's how to smoke-test it" note about Deno bundling of a `server/`-rooted
  import, rather than a confident claim either way.
- **Confirmed `api/_lib/push.ts`** is real, working precedent for cross-file sharing within
  `api/`'s own Vercel bundling — used today by `api/chat.ts` and `api/push.ts`.
- **Confirmed no ESLint config exists** in this repo at all (re-confirming the Phase 2 report),
  which is why §2 recommends but does not add an import-boundary lint rule.
- **Grepped the whole repo for wallet-ownership signature verification** (`verifyMessage`,
  `verifyTypedData`, `recoverAddress`, SIWE-style patterns) and found zero matches — the basis
  for §7's honest gap assessment rather than assuming a mechanism exists.

## 10. Framework independence (item 9: should the core accept a DB adapter instead of importing Supabase types?)

**Recommendation: yes, eventually — not changed in this pass.**

Current state, precisely:

- `types.ts` and `transitions.ts` have **zero** external dependencies (no Supabase import at
  all, of any kind) — these two files are already fully framework-independent and portable to
  any JS/TS runtime as-is, Deno included, with no changes.
- `apply.ts` imports `type { SupabaseClient } from '@supabase/supabase-js'` for its three public
  function signatures (`transitionIntent`/`transitionAttempt`/`transitionLedgerEvent`), and uses
  a looser structural type (`{ from: (table: string) => any }`) internally. This is a **type-level**
  dependency only — no code from the `@supabase/supabase-js` package is imported or executed at
  runtime by `apply.ts` beyond what the caller's own client instance already provides.

Why this matters concretely for this app, not just in the abstract: `wallet-key/index.ts`
imports Supabase via `jsr:@supabase/supabase-js@2` (a Deno/JSR specifier), while `src/lib/supabase.ts`
and any future `api/` code import the same package via plain npm (`@supabase/supabase-js`). These
are almost certainly structurally compatible (same underlying library, pinned to the same major
version) but this has **not been verified** — if a Phase 3 Edge Function tries to pass its
`jsr:`-imported client into a function typed as npm's `SupabaseClient`, TypeScript may or may not
accept it depending on how Deno's JSR-to-npm type bridging resolves in that project's toolchain,
which this ADR has not tested.

**Recommended target shape**, to be implemented when Phase 3 (or whichever phase first calls
these functions from Deno) actually needs it — not now, since "don't refactor the implementation
unless required for the boundary to be safe" and nothing calls this cross-runtime yet, so there's
no live bug to fix, only a risk to flag:

```ts
// A minimal, dependency-free contract instead of importing @supabase/supabase-js's type:
interface TransactionDbClient {
  from(table: string): {
    select(cols: string): { eq(col: string, val: unknown): { maybeSingle(): Promise<{ data: any; error: any }> } }
    update(payload: Record<string, unknown>): {
      eq(col: string, val: unknown): { eq(col2: string, val2: unknown): { select(cols: string): { maybeSingle(): Promise<{ data: any; error: any }> } } }
    }
  }
}
```

Any real Supabase client (npm or JSR-imported, Node or Deno) already satisfies this shape
structurally with no adapter code needed — TypeScript's structural typing means a real
`SupabaseClient` is assignable to `TransactionDbClient` without so much as a cast, so this change
is close to free when it happens (mechanical rename of the type import, not a logic change), and
low-risk to defer.

---

## 11. Summary — recommended server-side transaction-service structure

```
server/
  transactionStateMachine/     ← THIS ADR's subject. Exists today, moved here from src/lib/.
    types.ts                   ← zero dependencies, fully portable
    transitions.ts             ← zero dependencies, fully portable
    apply.ts                   ← one type-level Supabase dependency (§10 — defer swap to a
                                  minimal adapter interface until a real Deno caller needs it)
    index.ts
  transactionService/          ← NOT built yet. Phase 3+, one feature at a time. Each function:
                                  verify identity (§6/§7) → validate → call transactionStateMachine.
  _shared/ (maybe)             ← NOT built yet. A `verifySession.ts` helper generalizing
                                  wallet-key's auth.getUser(jwt) → public.users.id pattern,
                                  once a second caller needs the same logic (only one reference
                                  implementation — wallet-key itself — exists today).

api/                           ← Vercel functions. Import server/transactionService/ (not
                                  transactionStateMachine directly) once it exists, using their
                                  own service-role client (§3), never a VITE_ var.

supabase/functions/            ← Deno Edge Functions, including blockchain-indexer and a future
                                  reconciler. Same import pattern as api/, pending the Deno
                                  bundling smoke test noted in §4.

src/                           ← Browser bundle. MUST NEVER import server/**, confirmed
                                  structurally impossible via the Vite alias/build-root today
                                  (§9), not just documented as a rule.
```

**Confirmed, not merely asserted:**
- No browser path to service-role credentials: verified via `vite.config.ts` inspection + a
  repo-wide grep for any `src/**` import reaching into `server/**` (§9).
- The state machine is reusable by both Vercel API routes and Supabase Edge Functions in
  principle (dependency-injected client, no hardcoded environment) — Vercel's path is proven by
  existing precedent (`api/_lib/`); the Deno path relies on an inference from how
  `supabase/functions/_shared/` already works, explicitly flagged as unverified and worth a
  smoke test before Phase 3 relies on it (§4/§9).
