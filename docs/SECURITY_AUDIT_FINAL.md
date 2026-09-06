# Wallet Security Architecture — Final Pre-Production Audit

Reviewer stance: adversarial, as if for a fintech launch review. Scope is
the social-login (Google + Email-OTP) wallet-custody path only:
`supabase/functions/wallet-key/index.ts`, `supabase/functions/_shared/cors.ts`,
`supabase/migrations/20260720170000_*` / `20260720180000_*` / `20260721090000_*`,
`src/lib/restoreWallet.ts`, `src/lib/security.ts`, `src/lib/deviceId.ts`.
No code was changed to produce this document — findings only.

**Legend**: 🔴 High  🟠 Medium  🟡 Low  🟢 Reviewed, no issue found

---

## 1. Cryptography

| Item | Finding |
|---|---|
| HKDF usage | 🟢 Correct RFC 5869 usage via native WebCrypto (`deriveKey({name:'HKDF',...})`) in both derivation sites (per-wallet KEK, wallet-encryption key). `info` provides context separation; IKM is uniformly random (a MEK, or SHA-256 of the master secret) in both cases, which is exactly the case fixed-salt HKDF is valid for (see §2). |
| AES-256-GCM implementation | 🟢 Native WebCrypto (`crypto.subtle.encrypt/decrypt`, `{name:'AES-GCM'}`), 256-bit keys throughout, no custom/hand-rolled AES anywhere in scope. |
| IV generation | 🟢 96-bit (12-byte), fresh `crypto.getRandomValues` per encryption call, every call site. Correct length per NIST SP 800-38D recommendation for GCM. |
| Randomness source | 🟢 `crypto.getRandomValues` exclusively for all secret/IV material (MEK, salt, IV, `wallet_id` via `crypto.randomUUID()`). `secpUtils.randomPrivateKey()` (noble) also backs onto `crypto.getRandomValues` internally. No `Math.random()` anywhere in scope — verified by direct grep, zero matches. |
| Authentication tags | 🟢 WebCrypto's AES-GCM default tag length is 128 bits and is never overridden — correct, industry-standard. 🟡 *Minor*: the code never states `tagLength: 128` explicitly. Purely cosmetic — recommend adding it explicitly at each `encrypt`/`decrypt` call only for auditability, not because the implicit default is wrong. |
| Key sizes | 🟢 MEK: 256 bits. Derived wallet key: 256 bits (HKDF output length matches `AES-GCM length: 256`). Derived per-wallet KEK: 256 bits. All correct. |
| Key separation | 🟢 No key is ever reused across purposes: the per-wallet KEK only ever wraps that wallet's MEK; the MEK only ever derives that wallet's encryption key; the wallet-encryption key only ever encrypts that wallet's private key. Distinct `info` strings (`arcpay-user-kek:...` vs `arcpay-wallet-v2:...`) prevent cross-purpose key collision even though both derivations share design patterns. |

---

## 2. Envelope Encryption

- **No cryptographic weakness found in the envelope construction itself.**
  Master KEK → HKDF(info = kek_version, user_id, wallet_id) → per-wallet KEK
  → AES-GCM-wrap(MEK) → HKDF(salt = random, info = user_id, wallet_id) →
  wallet key → AES-GCM-wrap(private key). Two independent derivation
  layers, two independent ciphertexts, no shared key material between
  layers.
- **HKDF misuse check**: the per-wallet KEK derivation uses a **fixed,
  hardcoded salt** (`KEK_DERIVATION_SALT`) across every wallet. 🟢 **Not a
  weakness** — this is standard, correct HKDF usage when the IKM (here,
  `SHA-256(master secret)`) is already uniformly random and high-entropy:
  the salt's job (strengthening a possibly-weak IKM) isn't needed, and
  uniqueness comes from `info` instead, which correctly varies per wallet.
  This is the same pattern AWS/GCP KMS use internally for per-context key
  derivation. Confirmed correct, not a finding.
- **Observation, not a finding**: because salt and IKM are both fixed for
  a given `kek_version`, HKDF-Extract produces the same internal PRK on
  every single call — only HKDF-Expand's `info` actually varies. This is
  computationally redundant (re-running Extract every request) but has
  **zero security impact**; it's a micro-optimization opportunity only
  (cache the PRK per `kek_version` instead of re-deriving it from the
  master secret every call), not something worth changing pre-launch.
- **Per-wallet KEK derivation — verified correct**: `wallet_id` and
  `user_id` are never accepted from the client request body anywhere in
  `wallet-key/index.ts` (the body only ever contains `action` and
  `device_id` — confirmed by inspection). `wallet_id` is always either
  `crypto.randomUUID()` (freshly generated server-side) or read back from
  the row the server itself already fetched by verified `user_id`. There
  is no path by which a client can influence which KEK gets derived for a
  request.

---

## 3. Database

- **RLS**: both `wallet_vault` and `wallet_audit_log` have RLS **enabled
  with zero policies** for `anon`/`authenticated`, plus explicit `revoke
  all`. This is correct default-deny — verified by reading the migration
  SQL directly, not just the comments. 🟢
- **SQL permissions / privilege escalation**: no `SECURITY DEFINER`
  functions in scope (the `updated_at` trigger function is a trigger,
  callable only by the trigger machinery, not directly by SQL, and is
  `SECURITY INVOKER` by default anyway). No RPC exposed to
  `anon`/`authenticated` that touches these tables. 🟢 No privilege
  escalation path found within the reviewed migrations.
- 🟡 **Recommendation (verification, not a bug)**: confirm the Supabase
  project has no project-wide `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
  TABLES TO anon, authenticated` configured (a known footgun in some
  Supabase quick-start setups). It wouldn't affect these two tables,
  since the explicit `revoke all` runs after creation regardless — but if
  such a default exists, it silently weakens the security of *any future
  table* a less-careful migration forgets to revoke. Worth a one-time
  check (`\ddp` in `psql` or the dashboard's default-privileges view),
  not a code change.

---

## 4. Edge Functions

- **Timing attacks**: 🟢 No secret-dependent branching that leaks
  information to an unauthenticated party — every action requires a
  valid session first, and once authenticated, an attacker can only ever
  learn timing about their *own* account state, which they can already
  observe directly. Not an exploitable side channel.
- **Information leakage**: 🟠 **Two real findings.**
  1. `return json({ error: '...', detail: result.reason }, 500)` (the
     `generate-wallet` write-verification failure path) returns the raw
     internal failure reason — which can include literal Postgres error
     text (constraint names, table/column names) — directly to the
     client. This should be logged server-side only (already is, via
     `console.error`) and replaced with a generic client-facing message.
  2. `return json({ error: e instanceof Error ? e.message : ... }, 500)`
     in the `generate-wallet` encryption path will, in a
     misconfiguration scenario (e.g. `WALLET_MASTER_KEK_V1` unset),
     forward `getMasterKekSecret`'s error text — which explicitly
     documents the env var naming convention and the `supabase secrets
     set` command — straight to the caller. Low likelihood (only fires
     under active misconfiguration) but unnecessary reconnaissance value
     if it ever does. Same fix: log full detail server-side, return a
     generic message to the client.
- **Secret exposure**: 🟢 No master KEK, MEK, or derived key is ever
  written to a response body, log line, or the audit table — verified by
  reading every `json(...)` and `console.error(...)` call site in the
  file. The only secret that ever crosses the wire to the client, by
  design, is the plaintext private key itself, returned exactly once per
  successful `generate-wallet`/`restore-full-key` call to the verified
  owner — which is the documented, accepted design point of this
  architecture, not a leak.
- **Replay attacks**: 🟢 Both actions are naturally replay-safe:
  `generate-wallet` is idempotent (returns the existing wallet rather
  than creating a second one), and `restore-full-key` has no side effect
  beyond an idempotent opportunistic rewrap. A replayed request with an
  expired JWT is rejected by `supabase.auth.getUser`.
- **Race conditions**: 🔴 **One real, concrete bug.** Two concurrent
  `generate-wallet` calls for the *same brand-new user* (plausible in
  practice — e.g. a double-mount in React, a slow network causing a
  user/UI to retry) will both pass the "no existing row" check in
  `loadOrMigrateVaultRow()` before either has written anything, both
  generate a *different* wallet, and both attempt `writeAndVerify()`.
  `wallet_vault.user_id` is the primary key, so only one `INSERT`
  succeeds; the loser's insert fails (and its retry fails identically,
  since it's retrying with the same losing address, not a transient
  fault). **The bug**: `writeAndVerify()` updates `public.users.wallet_address`
  *before* attempting the `wallet_vault` insert. If the loser's `users`
  update happens to complete *after* the winner's, `public.users.wallet_address`
  ends up pointing at an address with **no corresponding `wallet_vault`
  row at all** — every other feature that reads `users.wallet_address`
  (payments, profile, username lookups) would show an address nothing
  can ever produce a key for. This is a data-integrity/availability bug,
  not a confidentiality leak (no key is exposed to the losing caller —
  it returns a 500), but it can strand a brand-new user's wallet
  reference. **Recommended fix** (conceptual, not implemented in this
  audit): resolve the `wallet_vault` insert conflict first (e.g. `insert
  ... on conflict (user_id) do nothing returning *`, and if zero rows
  came back, re-read the row that already exists — mirroring the pattern
  already used in the legacy-migration branch of this same file), and
  only update `public.users.wallet_address` with whichever address is
  confirmed to have actually won, never with the address this specific
  request happened to generate.

---

## 5. Authentication

- **Google Login / Email OTP**: delegated entirely to Supabase Auth
  (OAuth / OTP), not reimplemented anywhere in the reviewed files — this
  is the correct choice (do not hand-roll OTP generation/verification).
  🟡 Recommend a one-time check of the Supabase Auth dashboard settings
  for OTP: expiry window, resend cooldown, and max-attempts lockout — not
  a code issue, a configuration item to confirm before launch.
- **Session validation**: 🟢 Every action calls
  `supabase.auth.getUser(jwt)` — a real server-side verification against
  Supabase Auth (signature + expiry + revocation), not a local-only JWT
  decode. The verified `user_id` from that call, never anything the
  client claims, is what every subsequent query filters on.
- **Session expiration**: governed by Supabase project-level access-token
  TTL (not overridden anywhere in scope). 🟡 Recommend confirming the
  configured TTL matches your risk tolerance (a shorter-lived access
  token, paired with normal refresh-token rotation, reduces the window a
  stolen token remains useful — relevant to the "stolen session" row in
  the threat model below).
- **Token verification**: 🟢 No local-only JWT parsing/trust anywhere in
  the reviewed code — confirmed only the SDK's server-verified
  `getUser()` path is used.
- 🟠 **Authorization-scope gap (new finding, not previously flagged)**:
  the edge function authenticates *who* the caller is, but never checks
  *what kind of account* they are before acting. Nothing stops a
  create/import-wallet (self-custodial) user's browser session from
  calling `generate-wallet` directly (bypassing the UI, which normally
  only calls this for `loginType === 'social'`). Doing so would silently
  generate a *second*, server-custodial wallet and overwrite that
  account's `users.wallet_address` — not a cross-user compromise (still
  scoped to the caller's own row), but a real violation of the intended
  self-custodial guarantee ("create/import accounts never use this") and
  a potential source of user confusion / misdirected payments if it ever
  fires (accidentally, via a bug elsewhere, or a curious user in
  devtools). **Recommendation**: have the edge function check
  `users.login_type = 'social'` (or equivalent) before acting, returning
  403 otherwise — a small, targeted authorization check, not a new
  feature.

---

## 6. Wallet Restore

- **Cannot be restored by another authenticated user**: 🟢 Verified.
  Every query in `loadOrMigrateVaultRow()`, the `generate-wallet` write
  path, and `restore-full-key` filters exclusively on `userId`, which
  comes only from the server-verified JWT. There is no parameter
  anywhere in the request body (`action`, `device_id` only) that could
  let caller A request caller B's wallet. Confirmed by full read of the
  file — no `wallet_address`, `user_id`, or `wallet_id` is ever accepted
  as client input.
- **Ownership checks**: 🟢 Same conclusion — ownership is enforced by
  construction (every query is pre-scoped to the verified caller), not
  by a separate explicit check that could be forgotten on a new code
  path. This is a stronger pattern than "check ownership, then query,"
  because there's no window where an unscoped query could exist.
- **Authorization checks**: 🟢 for *identity* (see above). 🟠 for
  *account type* — see the authorization-scope gap in §5, which is the
  one real gap under this heading.

---

## 7. Logging

- **No secrets logged**: 🟢 Verified by reading every `console.error`
  and `console.warn` call site in `wallet-key/index.ts` and
  `restoreWallet.ts`. All log calls pass only: error messages generated
  by this code itself (never ciphertext, key, or MEK bytes), `user_id`,
  `wallet_id` (a random UUID, not sensitive), and Postgres error text
  (see the caveat below).
- 🟡 One caveat, low severity: a Postgres unique-constraint violation
  message *can* include the offending value in its `DETAIL` (not
  `message`, which is what's actually logged here) — and even if it did
  leak into a log, the only unique columns in `wallet_vault` are
  `user_id`, `wallet_id`, and `wallet_address`, none of which are secret
  (a wallet address is meant to be publicly discoverable by design in
  this app). No actionable risk, noted for completeness.
- **Audit log cannot leak sensitive information — mostly true, with one
  real gap**: 🟢 The schema itself makes it structurally impossible to
  log a key/MEK/KEK/ciphertext (see the prior review's §4). 🟠 **New
  finding**: `getClientIp()` takes the *first* entry of
  `x-forwarded-for`. If the platform's trusted proxy *appends* the real
  client IP to the end of that header (the common convention — proxies
  add their own hop, they don't necessarily strip attacker-supplied
  values from the front), a client can freely set their own
  `X-Forwarded-For` header to spoof an arbitrary `ip_address` value into
  the audit log. This directly undermines the log's value for exactly
  the investigative use case it exists for (incident response, insider-
  threat/account-takeover forensics). **Recommendation**: use the
  platform's documented "true client IP" header if one exists (Vercel:
  `x-vercel-forwarded-for` / `x-real-ip`; otherwise take the *last* entry
  of `x-forwarded-for`, not the first, and validate it's a well-formed IP
  before insert), and treat any audit `ip_address` as *supporting*
  evidence, not sole proof, until that's confirmed.

---

## 8. Dependencies

| Dependency | Assessment |
|---|---|
| `jsr:@supabase/supabase-js@2` | 🟢 Official SDK, standard choice, no concerns. |
| `npm:@noble/secp256k1@2`, `npm:@noble/hashes@1` | 🟢 Well-regarded, audited, dependency-free, widely used (same libraries viem itself uses). Correct choice over a heavier/less-reviewed alternative — no safer alternative to recommend here. |
| Native WebCrypto (AES-GCM, HKDF, SHA-256) | 🟢 Runtime-native (Deno/V8, backed by BoringSSL), not hand-rolled — the right default for every primitive it covers, and it covers everything except secp256k1 (which it doesn't support, correctly delegated to noble above). |
| 🟡 Version pinning | Import specifiers pin **major** version only (`@2`, `@1`). Recommend pinning exact versions (or committing a `deno.lock` and enforcing `--lock` in CI/deploy) so an unreviewed transitive update to a key-generation dependency can't land silently between review and deploy. Standard supply-chain hygiene, not a response to any known issue in these specific libraries. |

No unnecessary or unaudited cryptography libraries found anywhere in the
reviewed scope. This is a materially better dependency posture than a
typical early-stage fintech codebase.

---

## 9. Production checklist

**Environment variables**
- [ ] `WALLET_MASTER_KEK_V1` set (Supabase secret, not Vercel) — `openssl rand -hex 32`
- [ ] `WALLET_MASTER_KEK_CURRENT_VERSION` set (defaults to 1 if omitted)
- [ ] Legacy `WALLET_KEK` / `WALLET_KEY_ENCRYPTION_SECRET` kept at their
      *original* values until migration confirmed complete (see queries
      in `.env.example`), then removed
- [ ] Confirm no `WALLET_*` secret is ever readable from a `VITE_`-prefixed
      var or any client-bundled config (verified not to be — flagging as
      a pre-launch grep, not a finding)

**Secret rotation**
- [ ] Rotation runbook (documented in `.env.example` / prior review §5)
      tested at least once in a staging project before it's ever needed
      in production under pressure
- [ ] 🔴 **Highest-priority recommendation of this entire review**: move
      `WALLET_MASTER_KEK_V<n>` out of a raw environment variable and into
      a real KMS (AWS KMS, GCP Cloud KMS, or HashiCorp Vault Transit),
      with the Edge Function calling that service's `Decrypt`/`Unwrap`
      API instead of holding the master key material in its own process
      memory. This is a server-custodial-architecture change, **not**
      MPC — the server still unilaterally decrypts on a valid session,
      exactly as today. What it buys: an Edge Function RCE (§ threat
      model) no longer yields the master key itself for offline,
      unlimited use against a stolen database dump — it only yields the
      ability to decrypt accounts actively processed during the
      compromise window, which is a materially smaller blast radius and
      is independently revocable (KMS key policies, access logging,
      automatic rotation) in a way an env var fundamentally is not. This
      is the single change most worth making before a real fintech
      launch, and it fits entirely within the existing architecture.

**Backup strategy**
- [ ] Standard encrypted Postgres backups for `wallet_vault` /
      `wallet_audit_log` (Supabase default, confirm retention window)
- [ ] 🔴 **The master KEK must be backed up completely independently
      from the database** — different system, different access control,
      different people. Losing every configured `WALLET_MASTER_KEK_V<n>`
      permanently and irrecoverably destroys **every** social-login
      user's wallet at once; there is no recovery path from the database
      alone. Treat this secret's backup/recovery with at least the rigor
      of a production database's own encryption-at-rest key, not as "an
      env var someone remembers."

**Disaster recovery**
- [ ] Run a full recovery drill in a non-production project: restore a
      DB backup, restore the master KEK from its independent backup,
      confirm `restore-full-key` actually decrypts a real test account —
      before you need this to work for real
- [ ] Document the specific, tested procedure for a partial KEK-version
      loss (i.e., `WALLET_MASTER_KEK_V1` lost after most rows already
      rotated to V2) vs. total loss — the former is recoverable for
      already-rotated rows, the latter is not, and on-call staff need to
      know which situation they're in before acting

**Monitoring**
- [ ] Standard Edge Function error rate / latency (APM)
- [ ] `wallet_audit_log` volume of `decrypt_failure` (spikes indicate
      either a KEK misconfiguration or an active attack)
- [ ] `legacy_migration` success rate (should trend to zero failures and
      eventually zero volume as accounts finish migrating)
- [ ] `kek_rotation` success rate during any active rotation window

**Alerting**
- [ ] Alert on any `decrypt_failure` burst (even a handful in a short
      window, given expected steady-state volume should be ~zero)
- [ ] Alert on anomalous `restore_wallet` volume per `user_id` (many
      restores in a short window from varying `device_id`/`ip_address`
      is a classic account-takeover / stolen-session signal — this is
      exactly the pattern `wallet_audit_log` exists to surface, but it
      requires an actual alerting rule on top of it, not just storage)
- [ ] Alert on any read/access event against the KMS-held (or, until
      migrated, env-var-held) master KEK outside expected deploy/rotation
      windows

**Rate limiting**
- [ ] 🟠 **Currently absent.** Nothing in `wallet-key/index.ts` limits
      how often a single authenticated caller can invoke `restore-full-key`
      (or `generate-wallet`). Not directly brute-forceable (there's no
      secret to guess), but an unrate-limited endpoint that does real
      AES/HKDF work plus a DB write per call is a resource-exhaustion
      vector for a compromised/scripted session, and denies you the
      ability to distinguish "one confused client retrying" from "a
      script hammering this endpoint" without relying on alerting alone.
      Recommend a simple per-`user_id` rate limit (a handful of calls per
      minute is generous for legitimate use — this only fires on login/
      unlock) enforced either at the Edge Function layer or via your
      front door (see WAF below).

**WAF recommendations**
- [ ] Front the Supabase Edge Function URL (or the Vercel app + API
      routes generally) with a WAF/CDN capable of per-IP and per-token
      rate limiting (Cloudflare or Vercel's own bot/rate-limit rules),
      since neither Postgres RLS nor the Edge Function code itself
      currently provides this
- [ ] Once the CORS fix below ships, add a WAF rule rejecting requests to
      `/functions/v1/wallet-key` whose `Origin`/`Referer` doesn't match
      the known app origin(s), as defense-in-depth alongside the
      application-level fix (not a replacement for it)

---

## Consolidated weakness list (every item raised in this review)

| # | Finding | Severity | Category |
|---|---|---|---|
| 1 | Race condition: concurrent `generate-wallet` calls for a new user can leave `users.wallet_address` pointing at a row with no `wallet_vault` entry | 🔴 High | Edge Function / data integrity |
| 2 | Master KEK held as a raw environment variable rather than a KMS-backed key | 🔴 High (operational/architectural) | Key management |
| 3 | No independent, tested backup/DR procedure explicitly documented for the master KEK | 🔴 High (operational) | Disaster recovery |
| 4 | No account-type (`login_type`) authorization check before generating/restoring a server-custodial wallet | 🟠 Medium | Authorization |
| 5 | `Access-Control-Allow-Origin: '*'` on an endpoint returning plaintext private keys | 🟠 Medium | Edge Function / CORS |
| 6 | Internal error detail (`result.reason`, and `getMasterKekSecret`'s message) returned to the client on failure | 🟠 Medium | Information disclosure |
| 7 | `X-Forwarded-For` parsed naively (first entry), spoofable by the client, undermines audit log integrity | 🟠 Medium | Logging integrity |
| 8 | No rate limiting on `wallet-key` invocations | 🟠 Medium | Availability |
| 9 | Dependency imports pinned to major version only, no `deno.lock` enforcement mentioned | 🟡 Low | Supply chain |
| 10 | AES-GCM tag length left implicit rather than stated explicitly in code | 🟡 Low (cosmetic) | Code clarity |
| 11 | Redundant HKDF-Extract recomputation per request (fixed salt) | 🟡 Low (performance only) | Performance |
| 12 | Client-side passcode comparison (`security.ts`) not constant-time | 🟡 Low (pre-existing, local-device-only, out of scope) | Cryptography |

None of these require MPC or a change to the server-custodial trust
model to fix — every recommendation above (KMS-backed KEK included)
is achievable within the current architecture.

---

## 10. Final score: **7.5 / 10**

**What earns the 7.5, not lower**: the core cryptographic design is
genuinely sound — correct primitives, correct key sizes, correct IV/
randomness handling, real per-wallet key separation (not just per-row
ciphertext separation), ownership enforced by query construction rather
than a checkable-and-forgettable `if`, RLS default-deny verified by
reading the actual SQL, and an audit log whose schema makes secret-
leakage structurally difficult rather than merely discouraged by
convention. This is meaningfully better cryptographic engineering than
most pre-launch fintech codebases this reviewer has seen.

**What keeps it from an 8.5–9**: one concrete, reproducible bug (the
`generate-wallet` race condition, finding #1) that would fail a real
pre-launch security review outright until fixed — this is a "you will
hit this in production" issue, not a theoretical one. Combined with the
master-KEK-as-env-var gap (#2/#3), which is an accepted, honestly-
documented tradeoff but still the largest single operational risk in the
system (total, permanent, irrecoverable loss of every social-login
wallet if that secret and its backups are ever both lost), a 7.5 reflects
"strong design, not yet launch-ready without closing the High items."

**Path to 9+**: fix the race condition (#1), move the master KEK to a
KMS (#2), and have a tested, documented, independent KEK backup/DR
procedure (#3) before launch. Close the Medium items (#4–#8) in the same
release if possible, but they don't block launch the way #1–#3 do.
