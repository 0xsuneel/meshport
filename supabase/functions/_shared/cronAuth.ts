// Shared cron/service-caller check for edge functions invoked by pg_cron.
//
// ── Why this exists ────────────────────────────────────────────────────────
// These functions currently rely entirely on Supabase's own verify_jwt gate
// (validates the incoming bearer token's signature) to keep them from being
// called by an arbitrary client. Migrating off the legacy service_role JWT
// means verify_jwt has to come off too (the new sb_secret_... key format
// isn't a JWT at all, so verify_jwt=true can never accept it). Once
// verify_jwt is off, each function must do its own check.
//
// A JWT-decode-without-verify check (read the `role` claim out of the
// payload, trust it) is only safe WHILE verify_jwt=true already verified the
// signature upstream — the moment verify_jwt is off, that becomes forgeable:
// anyone can send a JWT-shaped string with `role: service_role` in the
// payload and no valid signature at all. This does a plain constant-time
// STRING comparison against known-good secret values instead — forging a
// match requires knowing the actual secret, not just crafting a shape.
//
// Accepts EITHER the new dedicated CRON_SECRET (edge function secret, not a
// SUPABASE_*-prefixed name since those are reserved) OR the legacy
// SUPABASE_SERVICE_ROLE_KEY (Supabase-managed, auto-injected) — both accepted
// simultaneously during the no-gap cutover. Legacy acceptance is removed only
// after a full day of clean cron runs confirms every job has cut over to
// CRON_SECRET.

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// NOTE: on this project, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') inside a
// running edge function is CONFIRMED (branch-tested) to NOT be the same
// value as the legacy JWT the pg_cron jobs currently send via the
// `claim_worker_service_key` vault secret — they're two different
// credentials. LEGACY_CRON_SECRET (below) is a temporary edge function
// secret set to mirror the vault secret's CURRENT value for the duration of
// the no-gap cutover, then removed once the vault value is updated to
// CRON_SECRET and a full day of clean cron runs confirms the cutover.
/** True if the request's Authorization bearer token matches CRON_SECRET or the (temporary, transition-only) legacy mirror. */
export function isCronOrLegacyServiceCaller(req: Request): boolean {
  const provided = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!provided) return false

  const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  if (cronSecret && timingSafeEqual(provided, cronSecret)) return true

  const legacyMirror = Deno.env.get('LEGACY_CRON_SECRET') ?? ''
  if (legacyMirror && timingSafeEqual(provided, legacyMirror)) return true

  return false
}
