import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { isAdminUser, fetchAdminRole } from '@/lib/adminSupabase'
import { AdminMfaGate } from '@/components/admin/AdminMfaGate'
import { useAdminStore } from '@/store/adminStore'
import { ADMIN_PATH } from '@/lib/adminPath'

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isAdminAuthenticated, setAdminSession, setAdminRole, clearAdminSession } = useAdminStore()
  const [checking, setChecking] = useState(true)
  const [status, setStatus] = useState<'allowed' | 'no-session' | 'not-admin'>(
    isAdminAuthenticated ? 'allowed' : 'no-session',
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      const session = data.session
      if (!session?.user) {
        if (!cancelled) { clearAdminSession(); setStatus('no-session'); setChecking(false) }
        return
      }
      const admin = await isAdminUser(session.user.id)
      if (cancelled) return
      if (admin) {
        setAdminSession(session.user.email ?? '')
        setAdminRole(await fetchAdminRole(session.user.id))
        setStatus('allowed')
      } else {
        // A logged-in MeshPort user without admin rights - send them home,
        // never show any admin UI.
        clearAdminSession()
        setStatus('not-admin')
      }
      setChecking(false)
    })()
    return () => { cancelled = true }
  }, [])

  if (checking) return null
  if (status === 'not-admin') return <Navigate to="/" replace />
  if (status === 'no-session') return <Navigate to={`${ADMIN_PATH}/login`} replace />
  return <AdminMfaGate>{children}</AdminMfaGate>
}
