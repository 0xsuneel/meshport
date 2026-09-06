/**
 * Admin panel URL prefix — single source of truth.
 *
 * Previously hardcoded as '/adminsun' in 6 different files. That's a
 * fixed, guessable path — anyone (a bot, a curious user, a scanner) could
 * type it directly and immediately learn "this app has an admin panel"
 * and land on its login screen, even though AdminGuard correctly blocks
 * actual admin CONTENT from anyone not in admin_users. Knowing the panel
 * exists at all, and being able to probe its login page, is itself
 * something worth not handing out for free.
 *
 * Set VITE_ADMIN_PANEL_PATH in your environment (Vercel + local .env) to
 * something private and unguessable, e.g.:
 *
 *   VITE_ADMIN_PANEL_PATH=mp-ctrl-7f2a9d
 *
 * If unset, falls back to the original '/adminsun' so nothing breaks for
 * anyone who hasn't set this yet — but you should set a real one. Do NOT
 * commit your actual chosen value to a public repo; keep it only in your
 * env vars, the same way you'd treat any other access credential.
 *
 * Note: this is "security by obscurity" for the DISCOVERY step only — it
 * is not, and was never meant to be, the actual security boundary.
 * AdminGuard's admin_users check is what actually protects the panel's
 * content; this just stops the login page itself from being trivially
 * stumbled onto or scanned for.
 */
const rawPath = (import.meta.env.VITE_ADMIN_PANEL_PATH || 'adminsun').trim()
// Normalize: no leading/trailing slashes, so callers can consistently do
// `${ADMIN_PATH}/login`, `${ADMIN_PATH}/dashboard`, etc.
export const ADMIN_PATH = '/' + rawPath.replace(/^\/+|\/+$/g, '')
