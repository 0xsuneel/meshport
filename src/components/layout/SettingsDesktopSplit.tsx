// SettingsDesktopSplit.tsx
// Pathless layout route around Settings (/profile) and its pages (Security,
// Appearance, Backup, Merchant, Help, Feature Guide, About,
// Terms) - the same idea as ChatDesktopSplit. Phones: renders <Outlet/> only,
// exactly as before. Desktop: a Settings menu column stays on the left and
// the chosen page opens beside it, every page in the same left-aligned width
// (.mp-settings-pane in index.css), instead of each page picking its own.
import { motion } from 'framer-motion'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Shield, Palette, Store, Upload, Key, HelpCircle, BookOpen, Info, FileText, User } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useAuthStore } from '@/store'
import { useMerchant } from '@/lib/merchant'
import { Avatar } from '@/components/ui/Avatar'

/** Paths that open inside the Settings split (desktop). */
export const SETTINGS_PATHS = ['/profile', '/edit-profile', '/security', '/appearance', '/backup', '/merchant', '/help-support', '/feature-guide', '/about', '/terms-privacy']
export const isSettingsPath = (path: string) => SETTINGS_PATHS.some(p => path === p || path.startsWith(p + '/'))

function Item({ icon, label, path, active, onClick }: { icon: ReactNode; label: string; path: string; active: boolean; onClick: (p: string) => void }) {
  return (
    <button onClick={() => onClick(path)} aria-current={active ? 'page' : undefined}
      className={active ? undefined : 'sidebar-nav-item'}
      style={{
        display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 10px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
        border: 'none', fontSize: 14, fontWeight: active ? 700 : 500,
        background: active ? 'color-mix(in srgb, var(--brand) 13%, transparent)' : 'transparent',
        color: active ? 'var(--brand-text)' : 'var(--text-primary)',
      }}>
      <span style={{ width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'color-mix(in srgb, var(--brand) 18%, transparent)' : 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
        color: active ? 'var(--brand-text)' : 'var(--text-secondary)' }}>{icon}</span>
      {label}
    </button>
  )
}

export function SettingsDesktopSplit() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const path = useLocation().pathname.replace(/\/$/, '') || '/'
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const loginType = useAuthStore(s => s.loginType)
  const walletSource = useAuthStore(s => s.walletSource)
  const merchant = useMerchant()

  if (!isDesktop) return <Outlet />

  const is = (p: string) => path === p || path.startsWith(p + '/')
  const go = (p: string) => { if (p !== path) navigate(p) }
  const name = user?.displayName || username || 'You'
  const handle = `${String(user?.username || username || name).replace(/\.arc$/, '')}.arc`
  const isWallet = loginType === 'wallet' || loginType === null
  // The pane keys on the page (not sub-steps like Change Passcode under Security).
  const pane = SETTINGS_PATHS.find(p => is(p)) ?? path

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <nav aria-label="Settings" style={{ width: 290, flexShrink: 0, height: '100%', minHeight: 0, overflowY: 'auto', borderRight: '1px solid var(--border)', padding: '20px 14px 24px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', padding: '0 6px 12px' }}>Settings</div>
        <button onClick={() => go('/profile')}
          style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: 12, marginBottom: 8, borderRadius: 16, cursor: 'pointer', textAlign: 'left',
            background: 'var(--surface)', border: `1px solid ${is('/profile') || is('/edit-profile') ? 'color-mix(in srgb, var(--brand) 45%, var(--border))' : 'var(--border)'}` }}>
          <Avatar name={name} src={user?.avatar} size="md" />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--link)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{handle}</span>
          </span>
        </button>

        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '10px 10px 4px' }}>Wallet</p>
        <Item icon={<User size={17} />} label="Profile" path="/profile" active={is('/profile') || is('/edit-profile')} onClick={go} />
        <Item icon={<Shield size={17} />} label="Security" path="/security" active={is('/security')} onClick={go} />
        <Item icon={<Palette size={17} />} label="Appearance" path="/appearance" active={is('/appearance')} onClick={go} />
        {isWallet && (
          <Item icon={walletSource === 'import-privkey' ? <Key size={17} /> : <Upload size={17} />} label="Backup & Recovery" path="/backup" active={is('/backup')} onClick={go} />
        )}
        <Item icon={<Store size={17} />} label={merchant.status === 'approved' ? 'Merchant account' : 'Apply for merchant'} path="/merchant" active={is('/merchant')} onClick={go} />

        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '14px 10px 4px' }}>Support</p>
        <Item icon={<HelpCircle size={17} />} label="Help & Support" path="/help-support" active={is('/help-support')} onClick={go} />
        <Item icon={<BookOpen size={17} />} label="Feature Guide" path="/feature-guide" active={is('/feature-guide')} onClick={go} />
        <Item icon={<Info size={17} />} label="About MeshPort" path="/about" active={is('/about')} onClick={go} />
        <Item icon={<FileText size={17} />} label="Terms & Privacy" path="/terms-privacy" active={is('/terms-privacy')} onClick={go} />
      </nav>
      <div style={{ flex: 1, minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Only this column changes between Settings pages; the menu stays put. */}
        <motion.div key={pane} className="mp-settings-pane" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </motion.div>
      </div>
    </div>
  )
}
