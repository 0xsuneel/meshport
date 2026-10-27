import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ChevronRight, Shield, Upload, Key,
  User, HelpCircle, Info, FileText, LogOut, BookOpen, Copy, Check, Share2, Palette, Sun, Moon, Store, X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAuthStore, useUIStore } from '@/store'
import { useThemeStore, resolveTheme } from '@/store/themeStore'
import { Avatar } from '@/components/ui/Avatar'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { copyToClipboard } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useMerchant } from '@/lib/merchant'
import { ArcStudioBadge } from '@/components/ui/ArcStudioBadge'

export function ProfilePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const loginType = useAuthStore(s => s.loginType)
  const walletSource = useAuthStore(s => s.walletSource)
  const logout = useAuthStore(s => s.logout)
  const { showToastMessage } = useUIStore()
  // Same theme store DesktopHeader's own toggle and Appearance settings
  // already use - this button flips light/dark directly, "System" stays
  // only pickable from Appearance.
  const mode = useThemeStore(s => s.mode)
  const setMode = useThemeStore(s => s.setMode)
  const isDark = resolveTheme(mode) === 'dark'
  const [copied, setCopied] = useState(false)
  const [usernameCopied, setUsernameCopied] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const merchant = useMerchant()

  if (!user) return null

  const isSocial = loginType === 'social'
  const isWallet = loginType === 'wallet' || loginType === null
  const displayUsername = username ? username : (user.username || '').replace(/\.arc$/, '')
  const displayName = user.displayName || (username ? username : (user.username || '').replace(/\.arc$/, '')) || 'MeshPort User'

  const handleCopyWallet = async () => {
    if (!walletAddress) return
    const ok = await copyToClipboard(walletAddress)
    setCopied(true)
    showToastMessage(ok ? 'Address copied' : 'Could not copy address', ok ? 'success' : 'error')
    setTimeout(() => setCopied(false), 1500)
  }

  // Payment link - same real, working pattern as ReceivePage.tsx
  const APP_URL = 'https://meshport.xyz'
  const cleanUsername = (displayUsername || '').replace(/\.arc$/, '')
  const paymentLink = cleanUsername
    ? `${APP_URL}/paylink/${cleanUsername}`
    : walletAddress
    ? `${APP_URL}/paylink/${walletAddress}`
    : APP_URL
  const handleSharePaymentLink = async () => {
    const shareData = {
      title: 'Pay me on MeshPort',
      text: cleanUsername ? `Send USDC to ${cleanUsername}.arc on MeshPort ⚡` : 'Send me USDC on MeshPort',
      url: paymentLink,
    }
    // navigator.share() support/behavior genuinely varies across browsers -
    // some don't implement it at all (most desktop browsers other than
    // Safari/Edge), some implement it but reject shareData shapes they
    // don't like via canShare(), and previously any rejection for ANY
    // reason was silently swallowed with an empty catch - so the button
    // would just appear to do nothing, with zero indication of why or
    // what to do instead. Every path below now either succeeds visibly or
    // falls back to copy-with-confirmation, never a silent no-op.
    const canUseNativeShare = typeof navigator.share === 'function' &&
      (typeof navigator.canShare !== 'function' || navigator.canShare(shareData))

    if (canUseNativeShare) {
      try {
        await navigator.share(shareData)
        return // user completed the native share sheet - nothing more to do
      } catch (err: any) {
        // AbortError means the user closed the share sheet themselves -
        // that's a deliberate cancel, not a failure, so don't show an
        // error or fall back to copying on top of it.
        if (err?.name === 'AbortError') return
        // Any other rejection (permissions, browser quirk, etc.) - fall
        // through to the clipboard fallback below instead of stopping here.
      }
    }

    const copied = await copyToClipboard(paymentLink)
    showToastMessage(copied ? 'Payment link copied to clipboard' : 'Could not copy link - try again', copied ? 'success' : 'error')
  }

  const handleLogout = () => { logout(); navigate('/auth', { replace: true }) }

  // Held in variables - not returned directly - so mobile (single stacked
  // column, unchanged order/output) and desktop (left column: profile +
  // wallet, right column: support) never duplicate this JSX.
  // Avatar and name in the middle, Edit profile / Share under them, then the
  // username and wallet address in one card, each with its own copy button.
  const handle = `${(displayUsername || displayName).replace(/\.arc$/, '')}.arc`
  const copyHandle = async () => {
    const ok = await copyToClipboard(handle)
    setUsernameCopied(true)
    showToastMessage(ok ? 'Username copied' : 'Could not copy username', ok ? 'success' : 'error')
    setTimeout(() => setUsernameCopied(false), 1500)
  }
  const idRow = (label: string, value: string, done: boolean, onCopy: () => void, mono?: boolean) => (
    <button type="button" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} className="mp-press"
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 0', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2, fontVariantNumeric: 'tabular-nums',
          fontFamily: mono ? 'var(--font-mono, ui-monospace, monospace)' : undefined, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      </span>
      <span style={{ width: 32, height: 32, borderRadius: 10, background: 'var(--tile-mint)', color: 'var(--tile-mint-ink)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        {done ? <Check data-tick className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </span>
    </button>
  )
  const userCardSection = (
    <div className="w-full">
      <div className="flex flex-col items-center text-center">
        {user.avatar
          ? <Avatar name={displayName} src={user.avatar} size="xl" className="!w-[72px] !h-[72px]" />
          : <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--mustard)', color: 'var(--mustard-ink)', display: 'grid', placeItems: 'center', fontSize: 24, fontWeight: 700 }}>
              {displayName.trim().split(/\s+/).map(w => w.charAt(0)).join('').slice(0, 2).toUpperCase()}
            </div>}
        <p className="text-text-primary font-bold text-[20px] leading-tight tracking-tight truncate max-w-full mt-3">{displayName}</p>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={() => navigate('/edit-profile')} className="mp-press inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[13px] font-semibold"
            style={{ background: 'var(--tile-mint)', color: 'var(--tile-mint-ink)', border: 'none' }}>
            <User className="w-3.5 h-3.5" /> Edit profile
          </button>
          <button onClick={handleSharePaymentLink} className="mp-press inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[13px] font-semibold text-text-primary"
            style={{ background: 'var(--surface)', boxShadow: 'var(--card-soft)', border: 'none' }}>
            <Share2 className="w-3.5 h-3.5" /> Share
          </button>
        </div>
      </div>
      <div className="mt-5" style={{ background: 'var(--surface)', borderRadius: 18, boxShadow: 'var(--card-soft)', padding: '2px 14px' }}>
        {idRow('Username', handle, usernameCopied, () => void copyHandle())}
        {walletAddress && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {idRow('Wallet address', `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`, copied, handleCopyWallet, true)}
          </div>
        )}
      </div>
    </div>
  )

  const walletSection = (
    <Section title="Wallet">
      <MenuItem icon={<Shield className="w-5 h-5" />} label="Security" color="bg-brand/20 text-brand-text" onClick={() => navigate('/security')} />
      <MenuItem icon={<Palette className="w-5 h-5" />} label="Appearance" color="bg-brand/20 text-brand-text" onClick={() => navigate('/appearance')} />
      {/* Business accounts only - personal accounts have no merchant option. */}
      {merchant.status !== 'none' && (
        <MenuItem icon={<Store className="w-5 h-5" />}
          label={merchant.status === 'approved' ? 'Business account'
            : merchant.status === 'pending' ? 'Business verification · In review'
            : 'Business verification'}
          color={merchant.status === 'approved' ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'}
          onClick={() => navigate('/merchant')} />
      )}

      {/*
        Backup menu items - rules by wallet type:
        'create'         → Seed Phrase Backup  +  Private Key Backup
        'import-seed'    → Seed Phrase Backup  +  Private Key Backup
        'import-privkey' → Private Key Backup only (no seed exists)
      */}
      {isWallet && (
        <>
          {/* Seed Phrase Backup - only for wallets that have a seed (create or import-seed) */}
          {(walletSource === 'create' || walletSource === 'import-seed' || walletSource === null) && (
            <MenuItem
              icon={<Upload className="w-5 h-5" />}
              label="Backup Seed Phrase"
              color="bg-accent/20 text-accent-text"
              onClick={() => navigate('/backup')}
            />
          )}

          {/* Private Key Backup - shown for ALL self-custody wallet types */}
          {walletSource === 'import-privkey' ? (
            /* Private-key-imported wallet: goes straight to the private-key-only backup page */
            <MenuItem
              icon={<Key className="w-5 h-5" />}
              label="Backup Private Key"
              color="bg-warning/20 text-warning"
              onClick={() => navigate('/backup')}
            />
          ) : (
            /* Seed wallets: also show Private Key Backup (opens backup page → Private Key tab) */
            <MenuItem
              icon={<Key className="w-5 h-5" />}
              label="Backup Private Key"
              color="bg-warning/20 text-warning"
              onClick={() => navigate('/backup?tab=key')}
            />
          )}
        </>
      )}
    </Section>
  )

  const supportSection = (
    <Section title="Support">
      <MenuItem icon={<BookOpen className="w-5 h-5" />} label="MeshPort Feature Guide" color="bg-success/20 text-success" onClick={() => navigate('/feature-guide')} />
      <MenuItem icon={<HelpCircle className="w-5 h-5" />} label="Help & Support" color="bg-brand/20 text-brand-text" onClick={() => navigate('/help-support')} />
      <MenuItem icon={<Info className="w-5 h-5" />} label="About MeshPort" color="bg-accent/20 text-accent-text" onClick={() => navigate('/about')} />
      <MenuItem icon={<FileText className="w-5 h-5" />} label="Terms & Privacy" color="bg-surface text-text-secondary" onClick={() => navigate('/terms-privacy')} />
      <MenuItem icon={<XLogo className="w-4 h-4" />} label="Follow us on X" color="bg-[rgb(var(--text-primary-rgb)/0.10)] text-text-primary" onClick={() => window.open('https://x.com/meshport_xyz', '_blank', 'noopener,noreferrer')} />
    </Section>
  )

  const signOutSection = (
    <button onClick={() => setShowLogoutConfirm(true)}
      className="flex items-center justify-center gap-2.5 w-full py-4 rounded-xl bg-danger/10 border border-danger/30 active:scale-[0.98] transition-transform">
      <LogOut className="w-[18px] h-[18px] text-danger" />
      <span className="text-sm font-bold text-danger">Sign Out</span>
    </button>
  )

  // Desktop: unchanged centered "Built On Arc Testnet" line (the Arc Studio
  // badge lives in the desktop sidebar instead). Mobile: "Built On Arc
  // Testnet" on the left, Arc Studio badge on the right.
  const builtOnArc = (
    <div className="flex items-center gap-1.5">
      <motion.span
        animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
        transition={{ duration: 1.1, repeat: Infinity }}
        className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"
      />
      <p className="text-xs text-text-secondary font-medium">Built On Arc Testnet</p>
    </div>
  )
  const footerSection = isDesktop ? (
    <div className="flex items-center justify-center pt-2 pb-1">{builtOnArc}</div>
  ) : (
    <div className="flex items-center justify-between gap-3 pt-2 pb-1">
      {builtOnArc}
      <ArcStudioBadge width={112} />
    </div>
  )

  return (
    <div className={isDesktop ? "h-full flex flex-col" : "flex-1 overflow-y-auto"}>
      {/* Header */}
      <div className="header-row sticky top-0 z-20 bg-bg justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate('/')} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Profile</h1>
        </div>
        {/* Small light/dark toggle, top-right - mobile only. Desktop already
            has the same toggle in DesktopHeader, so it isn't repeated here. */}
        {!isDesktop && (
          <button
            onClick={() => setMode(isDark ? 'light' : 'dark')}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-surface border border-border text-text-secondary active:scale-90 transition-transform"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        )}
      </div>

      <AnimatePresence>
        {showLogoutConfirm && (
        <DesktopDialogFrame onClose={() => setShowLogoutConfirm(false)} maxWidth={480}>
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h2 className="text-[19px] font-extrabold tracking-tight text-text-primary">Sign Out?</h2>
          <button onClick={() => setShowLogoutConfirm(false)} className="mp-popup-close ml-auto" aria-label="Close">
            <X className="w-[18px] h-[18px]" strokeWidth={2.4} />
          </button>
        </div>
        <div className="px-5 pb-6 space-y-4">
          <p className="text-sm text-text-secondary">
            {loginType === 'social'
              ? "You'll need your Gmail and the OTP sent to it to sign back in."
              : walletSource === 'import-privkey'
              ? "You'll need your private key to sign back in."
              : "You'll need your recovery phrase (seed phrase) to sign back in."}
          </p>
          <div className="flex gap-3">
            <button onClick={() => setShowLogoutConfirm(false)}
              className="flex-1 py-3.5 rounded-2xl text-text-primary text-[15px] font-bold active:scale-95 transition-transform bg-[rgb(var(--text-primary-rgb)/0.05)] border border-border">
              Cancel
            </button>
            <button onClick={handleLogout}
              className="flex-1 py-3.5 rounded-2xl text-white text-[15px] font-bold active:scale-95 transition-transform bg-danger"
              style={{ border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
              Confirm
            </button>
          </div>
        </div>
        </DesktopDialogFrame>
        )}
      </AnimatePresence>

      {isDesktop ? (
        // Left column: profile card + Wallet section (settings cards already
        // built above). Right column: Support. Same full-bleed (no maxWidth
        // cap), gap/padding treatment as Swap's 2-column layout - no root-
        // level overflow-hidden either (same clipping bug fixed on Swap/
        // Pay/Multichain Claim/Bulk Pay), each column scrolls on its own.
        // Desktop: the Settings menu (Wallet / Support pages) is the column
        // beside this one (SettingsDesktopSplit), so this pane is the profile
        // itself: card, Sign Out, footer.
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 20px 14px', boxSizing: 'border-box' }}>
          <div className="space-y-6">
            {userCardSection}
            {signOutSection}
            {footerSection}
          </div>
        </div>
      ) : (
        <div className="px-4 space-y-6 pb-8">
          {userCardSection}
          {walletSection}
          {supportSection}
          {signOutSection}
          {footerSection}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold text-text-secondary mb-3 px-1">{title}</p>
      <div className="bg-surface soft-card rounded-3xl divide-y divide-border">{children}</div>
    </div>
  )
}

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function MenuItem({ icon, label, color, onClick }: { icon: React.ReactNode; label: string; color: string; onClick: () => void }) {
  return (
    <motion.button whileTap={{ scale: 0.98 }} onClick={onClick}
      className="flex items-center gap-4 px-4 py-4 w-full hover:bg-[rgb(var(--text-primary-rgb)/0.05)] first:rounded-t-3xl last:rounded-b-3xl">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>{icon}</div>
      <span className="flex-1 text-sm font-medium text-text-primary text-left">{label}</span>
      <ChevronRight className="w-4 h-4 text-text-secondary" />
    </motion.button>
  )
}
