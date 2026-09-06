# Wallet Key — Disaster Recovery

Scope: the master KEK(s) behind `wallet_vault` (social-login wallet
custody). This is the single highest-stakes secret in the application —
read `docs/SECURITY_AUDIT_FINAL.md` §9 for why before anything else.

---

## What actually needs backing up, and why

| Asset | Loss impact | Backup owner |
|---|---|---|
| `wallet_vault` / `wallet_audit_log` (Postgres) | Without the matching KEK, this data alone is unusable to an attacker — but losing it (with no KEK loss) still means real users lose their wallets. | Supabase-managed Postgres backups (confirm retention window in the dashboard). |
| `WALLET_MASTER_KEK_V<n>` (every version any row still references) | **Total, permanent, irrecoverable loss of every social-login wallet that hasn't been exported/rotated elsewhere.** No amount of database access recovers anything without this. | Must be backed up **independently** of the database — different system, different access list, different person able to approve access. |
| `WALLET_KEY_ENCRYPTION_SECRET` / `WALLET_KEK` (legacy, migration-only) | Same class of impact, scoped to whichever accounts haven't yet lazily migrated off `version 0`/`version 1`. Shrinks toward zero impact as migration completes — see the query below. | Same rule as above, until migration is confirmed complete. |

**The rule that matters most**: a database backup and a KEK backup must
never live in the same place, be restorable by the same single person, or
be triggered by the same failure. If a compromise or deletion event could
plausibly take out both at once, they aren't actually independent.

---

## Backup procedure

1. Generate/rotate secrets only with `openssl rand -hex 32` (or an
   equivalent CSPRNG) — never a human-chosen value.
2. Store each `WALLET_MASTER_KEK_V<n>` in a secrets manager separate from
   both Supabase and Vercel (e.g., 1Password/Vaultwarden with restricted
   sharing, or a dedicated secrets vault) — not "a Slack message," not "a
   shared doc."
3. Record, alongside the secret itself: which `kek_version` it is, the
   date it was set, and the date (if any) it was retired.
4. Require two-person knowledge/approval to retrieve it in a real
   recovery — this is a break-glass secret, not a routine one.
5. Re-confirm the backup is actually readable on a schedule (e.g.
   quarterly) — an unverified backup is not a backup.

---

## Restore procedure (what to actually do if a KEK is lost)

**First, determine which scenario you're in — they are not equivalent:**

- **Scenario A — a non-current `kek_version` is lost, and rotation to a
  newer version already completed for all rows.** Check:
  ```sql
  select kek_version, count(*) from public.wallet_vault group by 1;
  ```
  If the lost version has zero rows referencing it, there is nothing to
  restore — safe to remove it from your secrets store and move on.

- **Scenario B — a `kek_version` still referenced by one or more rows is
  lost, and you have a valid backup.** Restore the secret from the
  independent backup, set it via `supabase secrets set
  WALLET_MASTER_KEK_V<n>=<restored value>`, and confirm with a real
  `restore-full-key` call against a test account on that version before
  considering the incident closed.

- **Scenario C — a `kek_version` still referenced by rows is lost, and
  there is no valid backup.** This is unrecoverable for every wallet still
  on that version — there is no mathematical way around this by design
  (that's the entire point of the encryption). Concretely:
  1. Identify the exact blast radius:
     ```sql
     select user_id, wallet_id from public.wallet_vault where kek_version = <lost version>;
     ```
  2. Every listed account's server-custodial wallet is gone. This is a
     genuine funds-loss incident for those users — treat it with the
     same severity and disclosure obligations as any other loss of
     custodied user funds, per your incident response and (if
     applicable) regulatory requirements.
  3. Post-incident: this scenario is exactly why Scenario A/B's backup
     discipline exists — the fix is process, applied going forward, not
     anything recoverable after the fact.

---

## Rotation (planned, not disaster) — quick reference

Full runbook lives in `.env.example` and `docs/SECURITY_ARCHITECTURE.md`
§5; summary:
1. `supabase secrets set WALLET_MASTER_KEK_V<n+1>=$(openssl rand -hex 32)`
2. `supabase secrets set WALLET_MASTER_KEK_CURRENT_VERSION=<n+1>`
3. Keep the old version's secret set until every row shows the new
   version in the query above.
4. Only then retire the old secret from both the running config and,
   after a safety interval, its backup store.

---

## Recovery testing — do this before you need it for real

Run in a **non-production** Supabase project, on a schedule (recommended:
quarterly, and after any change to this Edge Function or its migrations):

1. Seed a test account through the real signup flow (Google or Email-OTP)
   so it gets a genuine `wallet_vault` row.
2. Take a normal Postgres backup/restore of that project.
3. Separately, retrieve `WALLET_MASTER_KEK_V1` from its backup location
   (not from the running Supabase secrets — actually exercise the backup
   path).
4. Restore both into a fresh project instance.
5. Call `restore-full-key` for the test account and confirm the returned
   private key matches the original (compare the derived address, not
   the raw key, in whatever tooling you use for this drill).
6. Document how long the drill took and anything that wasn't as
   documented — update this file if reality diverged from the plan.

A recovery procedure that has never been executed is a hypothesis, not a
plan.

---

## Failure scenarios beyond total KEK loss

| Scenario | Handling |
|---|---|
| `WALLET_MASTER_KEK_CURRENT_VERSION` set to a version with no matching `WALLET_MASTER_KEK_V<n>` secret | New wallet creation fails loudly (`generate-wallet` returns a generic 500 to the client; the real cause is in server logs only — see `clientSafeError`). No silent data corruption — nothing is written half-encrypted. Fix: set the missing secret or point `CURRENT_VERSION` back at a valid one. |
| Legacy `WALLET_KEY_ENCRYPTION_SECRET` / `WALLET_KEK` removed before migration completes | Any not-yet-migrated account's `restore-full-key`/`generate-wallet` call fails (logged server-side, generic error to client) rather than corrupting data. Fix: restore the secret from backup, confirm the migration-progress query, then remove it properly once it's actually zero. |
| Partial rotation left permanently incomplete (some rows never log in again) | Not a system failure — those accounts simply keep working under their existing `kek_version` indefinitely, since old versions stay valid as long as their secret is kept. Only remove an old version's secret after confirming zero rows reference it. |
| Supabase project itself lost/deleted | Standard Supabase project-level DR applies to the data half; the KEK half is unaffected either way since it was never stored in that project's database in the first place — this is exactly why keeping it independent matters. |
