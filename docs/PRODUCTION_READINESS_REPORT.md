# Production Readiness Report — Wallet Key Hardening

This is the closing report for the fix pass against
`docs/SECURITY_AUDIT_FINAL.md`. Scope, constraint, and instruction as
given: fix every High/Medium finding, stay entirely within the existing
server-custodial envelope-encryption architecture, no MPC, no redesign.

---

## 1. Files changed

| File | What changed |
|---|---|
| `supabase/functions/wallet-key/index.ts` | Full rewrite (same architecture, same primitives) — race condition fix, KeyProvider abstraction, real `login_type` authorization check, configurable per-user + per-IP rate limiting, `clientSafeError()` for all client-facing responses, fixed `getClientIp()`, `wallet_address` now sourced from `wallet_vault` directly (removed a latent fallthrough bug — see §3). |
| `supabase/functions/_shared/cors.ts` | Added `corsHeadersFor`/`handleOptionsFor`/`jsonFor` (origin-aware, additive). Original `corsHeaders`/`handleOptions`/`json` untouched — `claim-submit` and `faucet-drip` are unaffected. |
| `supabase/migrations/20260722100000_users_login_type_and_audit_ip_index.sql` | New. Adds `users.login_type` (nullable, self-healing) and an index on `wallet_audit_log.ip_address` for the new rate limiter. |
| `src/lib/supabase.ts` | `upsertUserProfile` accepts an optional `loginType`, written only when provided (never clobbers an existing value). |
| `src/features/auth/AuthPages.tsx` | `ClaimUsernamePage`'s `upsertUserProfile` call now passes `loginType` from the auth store, so self-custodial accounts get tagged `'wallet'` going forward. **This is the only change to any create/import-wallet code path in this entire pass** — one field added to an existing call, no logic touched. |
| `.env.example` | Documents rate-limit env vars; `ALLOWED_ORIGIN` note updated for the Supabase-secret requirement (from the previous pass). |
| `docs/DISASTER_RECOVERY.md` | New — KEK backup/restore/rotation runbook and recovery-drill procedure (Priority 8). |
| `docs/PRODUCTION_READINESS_REPORT.md` | This file. |

Nothing in `src/lib/arc.ts`, `src/lib/security.ts`'s passcode/local-key
functions, or any create/import-wallet screen was touched.

---

## 2. Security improvements, mapped to the audit

| Audit finding | Fix |
|---|---|
| 🔴 Race condition (`generate-wallet`) | `wallet_vault` insert now happens *before* `users.wallet_address` is touched; `user_id` is its primary key, so only one concurrent insert for a new user can win. The losing request re-reads and returns the winner's wallet instead of erroring — idempotent under concurrency, not just idempotent sequentially. |
| 🟠 No account-type authorization | Real check against a persisted, server-verified `users.login_type` column. Self-custodial accounts (`login_type = 'wallet'`) get `403`. Rows that predate the column fall back to the same pragmatic heuristic as before, and every successful call self-heals the column going forward (no bulk backfill needed). |
| 🟠 CORS wildcard | `corsHeadersFor` echoes only `ALLOWED_ORIGIN` (falls back to `*` only if unset — set it before launch). |
| 🟠 Internal error detail leaked to client | `clientSafeError()` is now the *only* thing that produces client-facing error text anywhere in this file; every branch logs full detail server-side and returns a fixed, generic message. Verified by reading every `jsonFor(req, { error: ... })` call site — none interpolate caught exception text, Postgres error text, or config guidance anymore. |
| 🟠 IP spoofing in audit log | `getClientIp()` prefers a trusted platform header, else the *last* `X-Forwarded-For` hop (not the client-controllable first one), validated against a loose IP-shape check before use. |
| 🟠 No rate limiting | Per-user and per-IP, both configurable via env vars, applied to both actions, implemented by counting recent `wallet_audit_log` rows (no new infrastructure). Fails open on a query error so a logging hiccup never blocks a real login. |
| 🔴 Master KEK as raw env var | Not migrated to a real KMS, per instruction — **prepared for it**. All KEK-dependent operations now go through a `KeyProvider` interface; `EnvKeyProvider` is the only implementation and behaves identically to before. A future `KmsKeyProvider` implementing the same interface is the entire migration path, with zero business-logic changes. |
| 🔴 No independent, tested KEK backup/DR | Documented in full in `docs/DISASTER_RECOVERY.md` — backup ownership, restore procedure split by scenario (rotated-away version / valid backup / no backup), and a concrete recovery-drill procedure. Writing the document doesn't perform the drill — that's an operational action for your team, tracked in the checklist below. |

---

## 3. A bug I found (not in the original audit) while implementing the fix

While reordering the `generate-wallet` write path, I traced through when
`public.users` rows actually get created for a brand-new signup: **not**
at wallet generation — only later, at username-claim time
(`ClaimUsernamePage` → `upsertUserProfile`). That means, for a brand-new
social signup, the `users` row genuinely does not exist yet at the moment
`generate-wallet` first runs.

The previous revision's write-verification step used `.single()` after
updating `users.wallet_address`, which throws on zero matching rows —
meaning, if that code path was ever actually exercised end-to-end for a
brand-new user, it likely would have reported a false failure back to the
client on every first-time social signup. I did not have access to a live
database to confirm whether this ever manifested in practice (there may
be a Supabase-dashboard-configured trigger creating the row earlier, not
represented in this repo's SQL). Either way, the current version is
strictly safer: `users.wallet_address` sync is now treated as best-effort
for a new wallet (a real Postgres error still gets logged and surfaced;
"zero rows matched because the row doesn't exist yet" no longer fails the
request), and `wallet_vault` — not `users` — is now what every read path
actually trusts for `wallet_address`, closing a related fallthrough path
that could otherwise have silently generated a redundant second wallet.
**Recommend confirming directly against your live database** (does a
`public.users` row exist immediately after a fresh Google/Email-OTP
signup, before username claim?) so this note can be resolved with
certainty rather than reasoned about from the repo alone.

---

## 4. Verification checklist (please run before considering this done)

- [ ] `npm run typecheck && npm run lint` — not run in this sandbox (no
      network access to install dependencies here); this is a hard
      requirement before merge, not optional.
- [ ] Fresh Google signup end-to-end: passcode → wallet generated →
      username claim → home. Confirm `wallet_audit_log` shows
      `generate_wallet, success=true` and `users.login_type = 'social'`.
- [ ] Fresh Email-OTP signup: same check.
- [ ] Returning-user login (both providers): confirm `restore_wallet`
      logged, address unchanged, new passcode accepted.
- [ ] Existing pre-migration account (if any exist in your environment):
      confirm `legacy_migration, success=true` logs once, then normal
      `restore_wallet` afterward, and `users.encrypted_wallet_key` is
      cleared.
- [ ] create/import-wallet signup and login: confirm **zero** calls to
      the `wallet-key` function appear in its logs for these flows (they
      never should have, and this pass didn't change that path).
- [ ] Manually call the Edge Function with a self-custodial account's
      session (e.g. via `supabase.functions.invoke` in devtools) and
      confirm a `403`.
- [ ] Trigger the rate limit deliberately (loop `restore-full-key` past
      `WALLET_KEY_RATE_LIMIT_PER_USER`) and confirm `429`, then confirm
      normal use resumes after the window.
- [ ] Confirm `Access-Control-Allow-Origin` in a real response header
      matches your deployed frontend origin, not `*`.

---

## 5. Remaining limitations (honest, not resolved by this pass)

1. **Master KEK is still an environment variable**, not a KMS. The
   `KeyProvider` interface makes this a contained, well-defined future
   change rather than a repo-wide refactor — but it is not done. An Edge
   Function RCE or an env-var leak, combined with a database dump, is
   still sufficient to reconstruct wallets on the affected `kek_version`.
2. **KEK backup/DR is now documented, not yet executed.** A written
   runbook is not the same as a tested one — the recovery drill in
   `docs/DISASTER_RECOVERY.md` needs to actually be run.
3. **`login_type` authorization has a legacy-heuristic fallback**, not a
   universal guarantee, for accounts that predate the column and haven't
   logged in since this deployed. It closes to zero gap over time as
   accounts self-heal, but isn't instantaneous.
4. **Rate limiting is application-level only** — there's no WAF/CDN layer
   enforcing it independently, so a sufficiently distributed attacker
   (many IPs, one stolen session cycling through them) is throttled by
   the per-user limit alone, not blocked earlier at the edge. The
   previous audit's WAF recommendation still stands as a complementary
   layer, not a replacement for this.
5. **This pass could not be typechecked, linted, or run** in this
   environment (no network access to install dependencies) — treat every
   change as reviewed-by-reading, not verified-by-execution, until your
   own CI runs against it.

---

## 6. Production readiness score

**8.5 / 10** (up from 7.5 in the prior audit).

Every High and Medium item from `docs/SECURITY_AUDIT_FINAL.md` that was
fixable within the current architecture has been fixed and is traceable
in the table above. The score isn't higher because two of the three
🔴-severity items are explicitly *prepared for* rather than *resolved*
(KMS migration, executed DR drill) — by design, per this task's
instruction not to change infrastructure this pass — and because none of
this has been run through the project's own typecheck/lint/test suite
yet. Both remaining gaps have a clear, scoped, non-architectural next
step already written down (§5), which is what separates "not production
ready" from "production ready pending two tracked follow-ups."

---

## 7. Deployment checklist

Set secrets → run migrations → deploy function → deploy frontend →
verify. Full step-by-step commands are in the deployment guide from the
previous turn; what's **new** in this pass:

- [ ] New migration to run: `20260722100000_users_login_type_and_audit_ip_index.sql`
- [ ] New optional secrets (sane defaults apply if skipped):
      `WALLET_KEY_RATE_LIMIT_WINDOW_SECONDS`, `WALLET_KEY_RATE_LIMIT_PER_USER`,
      `WALLET_KEY_RATE_LIMIT_PER_IP`
- [ ] Confirm `ALLOWED_ORIGIN` is set as a **Supabase secret** (not just
      Vercel) — required for the CORS fix to actually take effect;
      without it, the function still works but falls back to `*`
- [ ] After deploy, run the verification checklist in §4 before
      considering this live
- [ ] Schedule the first KEK recovery drill (`docs/DISASTER_RECOVERY.md`)
      — not a deploy blocker, but shouldn't be indefinitely deferred either
