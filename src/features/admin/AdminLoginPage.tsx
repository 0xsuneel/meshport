import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Mail, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { adminSignIn } from '@/lib/adminSupabase'
import { useAdminStore } from '@/store/adminStore'
import { ADMIN_PATH } from '@/lib/adminPath'

export function AdminLoginPage() {
  const navigate = useNavigate()
  const setAdminSession = useAdminStore((s) => s.setAdminSession)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) { setError('Enter email and password'); return }
    setLoading(true)
    setError(null)
    const { error } = await adminSignIn(email, password)
    setLoading(false)
    if (error) { setError(error); return }
    setAdminSession(email.trim())
    navigate(`${ADMIN_PATH}/dashboard`, { replace: true })
  }

  return (
    <div style={{
      minHeight: '100dvh', background: 'var(--bg)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 20, background: 'var(--brand)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}>
            <ShieldCheck size={28} color="#fff" />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px', margin: 0 }}>Admin Control Panel</h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>Sign in with your MeshPort admin account</p>
        </div>

        <form onSubmit={handleSubmit} style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 20, padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Email</label>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginTop: 6,
              background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
              borderRadius: 14, padding: '12px 14px',
            }}>
              <Mail size={16} color="var(--text-secondary)" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@meshport.app"
                autoComplete="username"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 14 }}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Password</label>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginTop: 6,
              background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
              borderRadius: 14, padding: '12px 14px',
            }}>
              <Lock size={16} color="var(--text-secondary)" />
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 14 }}
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} style={{ background: 'none', border: 'none', display: 'flex' }}>
                {showPw ? <EyeOff size={16} color="var(--text-secondary)" /> : <Eye size={16} color="var(--text-secondary)" />}
              </button>
            </div>
          </div>

          {error && (
            <div style={{
              background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)',
              borderRadius: 12, padding: '10px 12px', color: 'var(--danger)', fontSize: 13,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary"
            style={{ padding: 16, borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', fontSize: 15, marginTop: 4, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)', marginTop: 20 }}>
          Restricted area — MeshPort owner access only.
        </p>
      </div>
    </div>
  )
}
