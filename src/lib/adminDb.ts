/// <reference types="vite/client" />
// The admin panel's own database client (19 Nov 2026). Its sign-in is kept
// apart from the app's (its own storage key): the app signs the wallet in
// (one shared identity per account, see lib/supabase walletSignIn) and that
// used to replace the admin's sign-in in the same browser - the admin pages
// still showed, but every save ran as the wallet's account and the database
// quietly refused it (an ad "turned off" stayed on). Now the two never touch.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = (import.meta.env.VITE_SUPABASE_URL  as string) || 'https://placeholder.supabase.co'
const SUPABASE_ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || 'placeholder-anon-key'

export const adminDb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { storageKey: 'mp-admin-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})
