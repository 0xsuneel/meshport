// The project's service-role key inside an Edge Function. Supabase injects
// the legacy SUPABASE_SERVICE_ROLE_KEY; projects on the new key format get
// SUPABASE_SECRET_KEYS (JSON) instead. One copy for every function (it used
// to be pasted into each), so a change to key lookup is made once.
export function getServiceRoleKey(label = 'edge-function'): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw)
      const candidate = parsed?.service_role ?? parsed?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(parsed ?? {})[0]
      if (typeof candidate === 'string' && candidate) return candidate
    } catch (e) {
      console.error(`[${label}] SUPABASE_SECRET_KEYS present but failed to parse:`, e instanceof Error ? e.message : e)
    }
  }
  throw new Error(
    `[${label}] No Supabase service role key found - checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS. ` +
    'Set one of them in the Edge Function secrets.',
  )
}
