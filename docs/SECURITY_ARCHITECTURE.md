# Wallet-Key Architecture — Security Review

Scope: `supabase/functions/wallet-key/`, `supabase/migrations/20260720170000_*`,
`20260720180000_*`, `20260721090000_*`, `src/lib/restoreWallet.ts`,
`src/lib/security.ts`, `src/lib/deviceId.ts`, `src/features/auth/AutoWalletPage.tsx`.
Applies to **social-login (Google + Email-OTP) wallets only** — create/import
wallets are self-custodial and out of scope for this document (they never
send key material to any server).

---

## 1. Architecture summary

```
Master KEK (env secret, WALLET_MASTER_KEK_V<n>)
        │  HKDF-SHA256(info = kek_version + user_id + wallet_id)
        ▼
Per-wallet KEK  (derived fresh, in memory, per request — never stored)
        │  AES-256-GCM
        ▼
encrypted_mek  ──decrypt──▶  MEK (random 256 bits, unique per wallet)
        │  HKDF-SHA256(info = user_id + wallet_id, salt = row.salt)
        ▼
Wallet-encryption key  (derived fresh, in memory, per request — never stored)
        │  AES-256-GCM
        ▼
encrypted_wallet  ──decrypt──▶  plaintext private key (held in browser memory only)
```

Stored, ever: `encrypted_wallet`, `encrypted_mek`, `iv`, `salt`, `version`,
`algorithm`, `kek_version`, `wallet_id`, `wallet_address`, timestamps.
Never stored: plaintext private key, seed phrase, MEK, KEK, any derived key.

---

## 2. Standards alignment

### OWASP ASVS (v4/v5, relevant sections)
- **V6 Cryptography** — AES-256-GCM (authenticated encryption, not just
  confidentiality) throughout; HKDF-SHA256 for all key derivation; unique
  IV per encryption operation, generated with `crypto.getRandomValues`
  (CSPRNG). Meets V6.2 (algorithm choice) and V6.3 (key management —
  rotation, versioning) requirements.
- **V8 Data Protection** — sensitive material never logged (§4 below),
  never returned except the one legitimate response for the authenticated
  owner, RLS default-deny on both tables (§3).
- **V2/V3 Auth & Session** — every action re-verifies the caller's live
  Supabase JWT server-side (`supabase.auth.getUser(jwt)`) before touching
  any row; the row touched is the verified `user_id`, never a client-
  supplied id. No action trusts anything the client claims about identity.
- **Gap, accepted deliberately**: ASVS V6.4 generally favors HSM/KMS-backed
  key custody over env-var secrets for root keys. This design uses env-var
  secrets (Supabase project secrets) for the master KEK — see §6, "KEK
  compromise," for the honest tradeoff and a concrete upgrade path.

### NIST SP 800-57 / SP 800-108 (key management / KDF)
- Envelope encryption (DEK-under-KEK, here MEK-under-derived-KEK) matches
  SP 800-57's key-hierarchy guidance directly.
- HKDF (SP 800-56C-compatible construction) used for derivation, not a
  password KDF (PBKDF2/Argon2) — correct, since the master KEK secret is
  already high-entropy (32 random bytes), not a human-chosen password.
  PBKDF2/Argon2 remain correctly used elsewhere in this codebase (see
  `security.ts`) for the actual passcode, which IS low-entropy.
- Key rotation without service interruption (SP 800-57 §8) — implemented
  via `kek_version` + lazy re-wrap; see §5.

### SOC 2 (Security / Availability / Confidentiality)
- **Audit trail** (`wallet_audit_log`) supports the CC7.2 monitoring
  criterion — who did what, when, from where, success/failure — without
  the log itself becoming a new sensitive-data surface (§4).
- **Change management**: every schema change is a numbered, reviewable
  migration with an explanatory header — supports CC8.1.
- **Gap**: this document is a starting point, not a completed control
  set. A real SOC 2 engagement needs access-review cadence, incident
  response runbooks, and vendor (Supabase, Vercel) sub-processor review,
  none of which are code-level concerns this PR can close.

### ISO/IEC 27001 (Annex A controls)
- A.8.24 (cryptographic controls) — algorithm/version metadata stored per
  row supports a documented cryptography policy and future algorithm
  migration without schema changes.
- A.8.15 (logging) — satisfied by `wallet_audit_log`, scoped narrowly per
  A.8.15's own guidance against over-collection of sensitive data in logs.
- A.5.15/A.8.2/A.8.3 (access control) — RLS default-deny + service-role-
  only access on both `wallet_vault` and `wallet_audit_log`.

---

## 3. Data access model (unchanged in spirit, now on two tables)

Both `wallet_vault` and `wallet_audit_log` have RLS **enabled with zero
policies** for `anon`/`authenticated`, plus explicit `revoke all`. That is
default-deny at the database level, independent of any application bug —
even a completely broken RLS policy elsewhere in the schema cannot expose
these tables, because there is no policy granting access to begin with.
The only path in is the `wallet-key` Edge Function, using the service role,
which bypasses RLS/grants by design (same as every other privileged
operation in this codebase).

---

## 4. Audit logging — what's captured, what's structurally impossible to capture

`wallet_audit_log` columns: `user_id`, `wallet_id`, `operation`, `success`,
`occurred_at`, `device_id`, `ip_address`. That's it — the table has no
other columns, so there is no column a secret could land in even by a
future coding mistake. `logAudit()` is the only writer and its TypeScript
signature accepts exactly those fields; nothing in the edge function ever
constructs a call passing a private key, MEK, ciphertext, or derived key
into it. `ip_address` is read server-side from proxy headers, never
trusted from the client body. `device_id` is a random, non-sensitive,
app-generated UUID (`src/lib/deviceId.ts`) — not a hardware fingerprint,
carries no authorization weight.

Recommended follow-up (not implemented in this PR, flagged for ops):
a retention/pruning job (e.g., delete rows older than your compliance
window) — the table is intentionally insert-only with no client-facing
delete path, so pruning should run as a scheduled job using the service
role directly.

---

## 5. Key rotation — how it actually works end-to-end

1. Ops provisions `WALLET_MASTER_KEK_V2` (new random secret) alongside the
   existing `WALLET_MASTER_KEK_V1` (must stay set), then sets
   `WALLET_MASTER_KEK_CURRENT_VERSION=2`.
2. **Nothing breaks at the moment of rotation.** Every row still has
   `kek_version = 1` and decrypts correctly — `getMasterKekSecret(1)` still
   resolves, because `WALLET_MASTER_KEK_V1` wasn't removed.
3. On the next successful `generate-wallet` or `restore-full-key` for any
   given row, `rewrapIfStale()` notices `row.kek_version (1) !==
   currentKekVersion (2)`, re-derives that wallet's KEK under v2, re-wraps
   just the MEK (never touches `encrypted_wallet`, since that layer
   doesn't depend on `kek_version` at all), and updates the row.
4. Rotation completes gradually, driven by real login traffic, with zero
   downtime and no bulk migration script needed. Progress is directly
   observable: `select kek_version, count(*) from wallet_vault group by 1;`
5. Once every row reports `kek_version = 2`, `WALLET_MASTER_KEK_V1` can be
   safely removed. Until then, removing it would strand any row that
   hasn't logged in since the rotation — check the query above first.

The same mechanism handles **scheme** upgrades (the `version` column) —
a future `version = 3` (e.g., a different AEAd algorithm entirely) would
add a new branch to `decryptByVersion()` and a new `envelopeEncryptWalletV3`
used by `rewrapIfStale()`, with `version = 1` and `version = 2` rows
continuing to decrypt under their own logic indefinitely, or until every
row has been rewrapped.

---

## 6. Threat model

| Attack | Can it compromise wallets? | Why / mitigation |
|---|---|---|
| **Supabase database leak** (full dump of `wallet_vault`) | **No, not on its own.** | Every row's ciphertext requires the master KEK (an env-only secret, never stored in the DB) to even begin decryption, plus that row's own `user_id`/`wallet_id` to derive the correct per-wallet KEK. A DB-only leak yields high-entropy ciphertext and metadata, nothing decryptable. |
| **Edge Function compromise** (attacker gets code execution inside `wallet-key`) | **Yes, for accounts actively used while compromised.** | The function has both the master KEK (env) and DB access by design — this is the same class of risk as `webserver.py compromise = complete breach` in any server-side-crypto system. Mitigated by: minimal function scope (this function does nothing else), the master KEK never leaving this function's process, and audit logs giving forensic visibility into which wallets were touched during the compromise window. Full elimination would require moving key custody to an HSM/KMS the function calls but never holds keys from directly — flagged as a future hardening step, not done here. |
| **Environment variable leak** (e.g., `WALLET_MASTER_KEK_V<n>` exposed via misconfigured logging/dashboard) | **Yes, but requires a second, independent failure to actually decrypt anything at scale.** | The leaked secret alone still needs the DB dump (`wallet_vault`) to do anything — and even then, only rows on that specific `kek_version` are affected. Rows already rotated to a newer `kek_version` are unaffected by an old leaked secret. This is the direct payoff of per-version + per-wallet derivation: a leak is contained to (secret × rows still on that version), not the whole table. |
| **KEK compromise** (master secret obtained by any means) | **Yes, for rows on that `kek_version`, combined with a DB dump.** Same as above — this is the honestly-stated residual risk of any server-custodial design (see the Edge Function's header comment). Response: rotate immediately (§5); rows rotate out of exposure as users log in. |
| **Replay attack** (resending a captured request) | **No.** | Every request requires a live, valid Supabase JWT verified server-side per call; a replayed request either uses an already-expired token (rejected by `supabase.auth.getUser`) or, if somehow still valid, simply re-authorizes the same legitimate action for the same legitimate user — there is no state-changing side effect from a replay that differs from a normal duplicate call (`generate-wallet` is idempotent by design). |
| **MITM attack** | **No, assuming TLS holds.** | All traffic is HTTPS (Supabase Edge Functions, enforced platform-wide); no key material is ever transmitted except the one-time plaintext-key response over that TLS channel to the already-authenticated owner. A MITM that can break TLS itself is a platform-level compromise outside this component's threat model. |
| **Brute force** | **No meaningful attack surface here.** | There's no passcode-derived key to brute-force in this path at all (the whole point of this design) — the passcode never touches wallet encryption. The only "guessable" secrets are 256-bit random values (MEK) or HKDF-derived 256-bit keys, both computationally infeasible to brute-force. |
| **Stolen session** (attacker obtains a valid JWT, e.g. via XSS) | **Yes — this is the correctly-scoped failure mode.** | A stolen session lets an attacker call `restore-full-key` and obtain that ONE user's plaintext key, same as it would let them do anything else that user's session can do (send funds, etc.). This is an application-session-security problem (XSS prevention, JWT lifetime/refresh hygiene), not something the envelope-encryption layer is meant to solve — by design, a valid session IS the authorization for a social-login wallet. Out of scope for this document; see general web app security practices (CSP, HttpOnly where applicable, short-lived tokens). |
| **Insider attack** (someone with prod DB + secrets access) | **Yes, structurally unavoidable for any design where the server can decrypt on-demand without additional user interaction.** | Mitigated, not eliminated: access to `WALLET_MASTER_KEK_V<n>` should be restricted to as few people/systems as possible (secrets manager with its own access log, not shared casually); `wallet_audit_log` gives a trail of which wallets were actually accessed and when, which is exactly the kind of evidence an insider-threat investigation needs. Full elimination requires a fundamentally different model (client-side/passkey-derived keys, previously tried and reverted for reliability reasons — see `restoreWallet.ts` history). |

**Summary**: the design correctly contains partial compromises (single
secret, single row, single KEK version) to their actual blast radius, and
is honest that a *combined* database-dump-plus-live-master-KEK compromise,
or a compromise of the Edge Function's own runtime, remains a real
single-point-of-failure class — same conclusion the codebase's own prior
comments reached, now with a smaller and better-instrumented blast radius
than before.

---

## 7. Performance

All added cryptographic work is in-memory, sub-millisecond operations on
Deno's native WebCrypto (hardware-accelerated AES-GCM, hardware-accelerated
SHA-256 for HKDF) — negligible next to the network round-trips already in
this flow (Google OAuth / Supabase Auth OTP verification, the Edge
Function invocation itself). Concretely, per request:
- 1–2 HKDF derivations (SHA-256, 32-byte input) — microseconds.
- 2 AES-256-GCM operations (encrypt or decrypt), both on tiny payloads (a
  32-byte MEK, a ~66-byte private key) — microseconds.
- 1 DB read (`wallet_vault`, single row, indexed by `user_id` primary key)
  for the common case; `rewrapIfStale`/legacy-migration paths add at most
  one additional read + one write, and only for rows not yet on the
  current version — a one-time cost per wallet, not a steady-state cost.
- 1 audit-log insert, fire-and-forget in effect (awaited, but failures are
  caught and never block the response) — a single-row insert into an
  indexed, unpartitioned table.

No client-visible latency regression is expected versus the previous
single-layer design; the dominant cost in this flow was, and remains,
the OAuth/OTP round trip, not the cryptography.

---

## 8. Production readiness checklist

- [ ] `supabase secrets set WALLET_MASTER_KEK_V1=$(openssl rand -hex 32)`
- [ ] Keep `WALLET_KEK` and `WALLET_KEY_ENCRYPTION_SECRET` set to their
      **original** values (do not rotate) until migration completes —
      see `.env.example` for exact verification queries.
- [ ] Deploy migrations in order: `20260720170000` → `20260720180000`
      (will refuse to run until migrated — expected on first deploy) →
      `20260721090000`.
- [ ] Deploy the updated `wallet-key` Edge Function.
- [ ] Run `npm run typecheck` and `npm run lint` (not run in this sandbox
      — no network access to install dependencies here).
- [ ] Confirm `wallet_audit_log` is receiving rows for both `generate_wallet`
      and `restore_wallet` operations after a real login.
- [ ] create/import-wallet flows are **unchanged** — no code in
      `AuthPages.tsx`'s create/import handlers, `arc.ts`, or `security.ts`'s
      passcode-encryption functions was modified by this work.
- [ ] Legacy code fully retired: no remaining reference to Shamir shares,
      passkey/WebAuthn wallet backup, or the single-global-KEK-only design
      exists in application code — those were already removed in prior
      migrations/commits; this PR's job was the *storage/encryption* layer
      behind the login flow, not the login flow itself.
