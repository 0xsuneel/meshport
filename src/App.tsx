import { useState, useEffect, Suspense } from 'react'
import { useIsStandalone } from './hooks/useIsStandalone'
import { createBrowserRouter, RouterProvider, Navigate, useLocation } from 'react-router-dom'
import { useBusinessTab } from './lib/merchant'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from './store'
import { markSplashDone } from './lib/splash'
import { useOnReconnect, isSlowNetwork, whenNetworkOk } from './lib/connectivity'
import { AppLayout } from './components/layout/AppLayout'
import { AuthShell } from './components/layout/AuthShell'
import { SettingsDesktopSplit } from '@/components/layout/SettingsDesktopSplit'
import { ChatDesktopSplit } from './components/layout/ChatDesktopSplit'
import { ADMIN_PATH } from './lib/adminPath'
import { lazyRetry } from './lib/lazyRetry'
import { RouteErrorPage } from './components/RouteErrorPage'
import { OfflineBanner } from './components/ui/OfflineBanner'

// ── Lazy-loaded pages ────────────────────────────────────────────────────────
// Every page below used to be a static top-level import, meaning the entire
// app - Home, Chat, Multichain, the whole Admin panel, everything - was
// bundled together into one chunk that had to be downloaded and parsed
// before ANY route could render. That's especially costly for pages meant to
// be opened cold by strangers from an external link - like a payment link
// (/pay/:username) - where someone was paying the full cost of the entire
// app just to see a small landing page. Wrapping each page in lazyRetry()
// gives every route its own small chunk, so visiting one route no longer
// forces a download of all the others - and auto-recovers (one reload) if a
// route's chunk went stale because a new version was deployed while someone
// already had the app open, instead of showing a broken error screen.
const HomePage             = lazyRetry(() => import('./features/home/HomePage').then(m => ({ default: m.HomePage })), 'HomePage')
const PaySendPage              = lazyRetry(() => import('./features/paysend/PaySendPage').then(m => ({ default: m.PaySendPage })), 'PaySendPage')
const P2PHubPage            = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PHubPage })), 'P2PHubPage')
const P2PCreateOfferPage    = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PCreateOfferPage })), 'P2PCreateOfferPage')
const P2POfferDetailPage    = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2POfferDetailPage })), 'P2POfferDetailPage')
const P2PTradePage          = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PTradePage })), 'P2PTradePage')
const P2PMyOffersPage       = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PMyOffersPage })), 'P2PMyOffersPage')
const P2PMyTradesPage       = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PMyTradesPage })), 'P2PMyTradesPage')
const P2PHistoryPage        = lazyRetry(() => import('./features/p2p/HistoryPage').then(m => ({ default: m.P2PHistoryPage })), 'P2PHistoryPage')
const MultichainPage        = lazyRetry(() => import('./features/multichain/MultichainPage').then(m => ({ default: m.MultichainPage })), 'MultichainPage')
const MultichainRecoveryPage = lazyRetry(() => import('./features/multichain/MultichainRecoveryPage').then(m => ({ default: m.MultichainRecoveryPage })), 'MultichainRecoveryPage')
const ReceivePage           = lazyRetry(() => import('./features/receive/ReceivePage').then(m => ({ default: m.ReceivePage })), 'ReceivePage')
const MyRequestsPage        = lazyRetry(() => import('./features/receive/MyRequestsPage').then(m => ({ default: m.MyRequestsPage })), 'MyRequestsPage')
const ScannerPage           = lazyRetry(() => import('./features/scanner/ScannerPage').then(m => ({ default: m.ScannerPage })), 'ScannerPage')
const ChatPrivacyPage       = lazyRetry(() => import('./features/chat/ChatPrivacyPage').then(m => ({ default: m.ChatPrivacyPage })), 'ChatPrivacyPage')
const ChatListPage          = lazyRetry(() => import('./features/chat/ChatPage').then(m => ({ default: m.ChatListPage })), 'ChatListPage')
const ChatConversationPage  = lazyRetry(() => import('./features/chat/ChatPage').then(m => ({ default: m.ChatConversationPage })), 'ChatConversationPage')
const ActivityPage          = lazyRetry(() => import('./features/activity/ActivityPage').then(m => ({ default: m.ActivityPage })), 'ActivityPage')
const TransactionDetailPage = lazyRetry(() => import('./features/activity/TransactionDetail').then(m => ({ default: m.TransactionDetailPage })), 'TransactionDetailPage')
const InsightsPage          = lazyRetry(() => import('./features/insights/InsightsRoute').then(m => ({ default: m.InsightsRoute })), 'InsightsPage')
const BusinessPage          = lazyRetry(() => import('./features/business/BusinessPage').then(m => ({ default: m.BusinessPage })), 'BusinessPage')
const RewardsPage           = lazyRetry(() => import('./features/rewards/RewardsPage').then(m => ({ default: m.RewardsPage })), 'RewardsPage')
const AssetPage             = lazyRetry(() => import('./features/home/AssetPage').then(m => ({ default: m.AssetPage })), 'AssetPage')
const RecentPaidPage        = lazyRetry(() => import('./features/recent/RecentPaidPage').then(m => ({ default: m.RecentPaidPage })), 'RecentPaidPage')
const NewsPage              = lazyRetry(() => import('./features/news/NewsPage').then(m => ({ default: m.NewsPage })), 'NewsPage')
const NewsArticlePage       = lazyRetry(() => import('./features/news/NewsArticlePage').then(m => ({ default: m.NewsArticlePage })), 'NewsArticlePage')
const BulkPayoutPage        = lazyRetry(() => import('./features/bulkpayout/BulkPayoutPage').then(m => ({ default: m.BulkPayoutPage })), 'BulkPayoutPage')
const ProfilePage           = lazyRetry(() => import('./features/profile/ProfilePage').then(m => ({ default: m.ProfilePage })), 'ProfilePage')
const CircleWalletPage      = lazyRetry(() => import('./features/profile/CircleWalletPage').then(m => ({ default: m.CircleWalletPage })), 'CircleWalletPage')
const CircleLoginReturnPage = lazyRetry(() => import('./features/profile/CircleWalletPage').then(m => ({ default: m.CircleLoginReturnPage })), 'CircleLoginReturnPage')
const SecurityPage          = lazyRetry(() => import('./features/profile/ProfileSubPages').then(m => ({ default: m.SecurityPage })), 'SecurityPage')
const AppearancePage        = lazyRetry(() => import('./features/profile/ProfileSubPages').then(m => ({ default: m.AppearancePage })), 'AppearancePage')
const BackupPage            = lazyRetry(() => import('./features/profile/ProfileSubPages').then(m => ({ default: m.BackupPage })), 'BackupPage')
const ChangePasscodePage    = lazyRetry(() => import('./features/profile/ProfileSubPages').then(m => ({ default: m.ChangePasscodePage })), 'ChangePasscodePage')
const EditProfilePage       = lazyRetry(() => import('./features/profile/ProfileSubPages').then(m => ({ default: m.EditProfilePage })), 'EditProfilePage')
const NotificationsPage     = lazyRetry(() => import('./features/profile/ProfileSubPages').then(m => ({ default: m.NotificationsPage })), 'NotificationsPage')
const FeatureGuidePage      = lazyRetry(() => import('./features/profile/FeatureGuidePage').then(m => ({ default: m.FeatureGuidePage })), 'FeatureGuidePage')
const AboutPage             = lazyRetry(() => import('./features/profile/AboutPage').then(m => ({ default: m.AboutPage })), 'AboutPage')
const TermsPrivacyPage      = lazyRetry(() => import('./features/profile/TermsPrivacyPage').then(m => ({ default: m.TermsPrivacyPage })), 'TermsPrivacyPage')
const HelpSupportPage       = lazyRetry(() => import('./features/profile/HelpSupportPage').then(m => ({ default: m.HelpSupportPage })), 'HelpSupportPage')
const SwapPage              = lazyRetry(() => import('./features/swap/SwapPage').then(m => ({ default: m.SwapPage })), 'SwapPage')
const LoginPage             = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.LoginPage })), 'LoginPage')
const GoogleAuthPage        = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.GoogleAuthPage })), 'GoogleAuthPage')
const EmailOTPPage          = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.EmailOTPPage })), 'EmailOTPPage')
const CreateWalletPage      = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.CreateWalletPage })), 'CreateWalletPage')
const ImportWalletPage      = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.ImportWalletPage })), 'ImportWalletPage')
const WalletSetupPage       = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.WalletSetupPage })), 'WalletSetupPage')
const ClaimUsernamePage     = lazyRetry(() => import('./features/auth/AuthPages').then(m => ({ default: m.ClaimUsernamePage })), 'ClaimUsernamePage')
const PasscodeSetupPage     = lazyRetry(() => import('./features/auth/PasscodeSetup').then(m => ({ default: m.PasscodeSetupPage })), 'PasscodeSetupPage')
const PasscodeLockPage      = lazyRetry(() => import('./features/auth/PasscodeSetup').then(m => ({ default: m.PasscodeLockPage })), 'PasscodeLockPage')
const EnableBiometricPage   = lazyRetry(() => import('./features/auth/EnableBiometricPage').then(m => ({ default: m.EnableBiometricPage })), 'EnableBiometricPage')
const AutoWalletPage        = lazyRetry(() => import('./features/auth/AutoWalletPage').then(m => ({ default: m.AutoWalletPage })), 'AutoWalletPage')
const LandingPage           = lazyRetry(() => import('./features/landing/LandingPage').then(m => ({ default: m.LandingPage })), 'LandingPage')
// PayPage is the one route that most benefits from being kept as light as
// possible - it's the page a brand-new visitor (no session, nothing cached)
// lands on cold from an external payment link, so it's imported eagerly
// rather than lazily: for THIS specific route, avoiding an extra
// lazy-chunk network round-trip on top of the initial page load matters
// more than shaving bytes off the main bundle.
import { PayPage } from './features/pay/PayPage'
import { useSettingsStore } from './store/settingsStore'
import { FeatureGate } from './components/admin/FeatureGate'
import { RequireUnlockedAccount as Unlocked } from './components/LockedFeature'
import { PrivyGate } from './wallet/PrivyGate'

function LegacyMultichainRedirect({ tab }: { tab: 'transfer' | 'bring' }) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  params.set('tab', tab)
  return <Navigate to={`/multichain?${params.toString()}`} replace state={{ ...(location.state as any ?? {}), tab }} />
}
// Paths renamed: the in-app Pay screen moved /pay-send → /pay, and public
// payment links moved /pay/<username> → /paylink/<username> (merchant
// /pay/r/<code> → /paylink/r/<code>). Old links - already shared, sitting in
// chat history or printed as QR codes - land on the new path, keeping their
// ?to= / ?amount= query and any navigation state.
// Rewards (daily tasks, points) is for personal accounts only - a business
// account that lands here (an old link, a saved shortcut) goes to Business.
function PersonalOnly({ children }: { children: React.ReactNode }) {
  return useBusinessTab() ? <Navigate to="/business" replace /> : <>{children}</>
}

function RenamedPathRedirect({ from, to }: { from: string; to: string }) {
  const location = useLocation()
  const rest = location.pathname.slice(from.length)
  return <Navigate to={`${to}${rest}${location.search}${location.hash}`} replace state={location.state} />
}
import { MaintenanceGate } from './components/admin/MaintenanceGate'
import { AdminGuard } from './features/admin/AdminGuard'
const AdminLoginPage           = lazyRetry(() => import('./features/admin/AdminLoginPage').then(m => ({ default: m.AdminLoginPage })), 'AdminLoginPage')
const AdminLayout              = lazyRetry(() => import('./features/admin/AdminLayout').then(m => ({ default: m.AdminLayout })), 'AdminLayout')
const AdminDashboardPage       = lazyRetry(() => import('./features/admin/DashboardPage').then(m => ({ default: m.DashboardPage })), 'AdminDashboardPage')
const AdminFeaturesPage        = lazyRetry(() => import('./features/admin/FeaturesPage').then(m => ({ default: m.FeaturesPage })), 'AdminFeaturesPage')
const AdminCoinsPage           = lazyRetry(() => import('./features/admin/CoinsPage').then(m => ({ default: m.CoinsPage })), 'AdminCoinsPage')
const AdminChainsPage          = lazyRetry(() => import('./features/admin/ChainsPage').then(m => ({ default: m.ChainsPage })), 'AdminChainsPage')
const P2PGuidePage             = lazyRetry(() => import('./features/p2p/P2PGuidePage').then(m => ({ default: m.P2PGuidePage })), 'P2PGuidePage')
const P2PAdminPage             = lazyRetry(() => import('./features/p2p/P2PAdminPage').then(m => ({ default: m.P2PAdminPage })), 'P2PAdminPage')
const TreasuryAdminPage        = lazyRetry(() => import('./features/admin/TreasuryAdminPage').then(m => ({ default: m.TreasuryAdminPage })), 'TreasuryAdminPage')
const AdminAnalyticsPage       = lazyRetry(() => import('./features/admin/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })), 'AdminAnalyticsPage')
const NewsAdminPage = lazyRetry(() => import('./features/admin/NewsAdminPage').then(m => ({ default: m.NewsAdminPage })), 'NewsAdminPage')
const NotificationBroadcastPage = lazyRetry(() => import('./features/admin/NotificationBroadcastPage').then(m => ({ default: m.NotificationBroadcastPage })), 'NotificationBroadcastPage')
const AdminMaintenancePage     = lazyRetry(() => import('./features/admin/MaintenancePage').then(m => ({ default: m.MaintenancePage })), 'AdminMaintenancePage')
const AdminLogsPage            = lazyRetry(() => import('./features/admin/LogsPage').then(m => ({ default: m.LogsPage })), 'AdminLogsPage')
const AdminSupportTicketsPage  = lazyRetry(() => import('./features/admin/SupportTicketsPage').then(m => ({ default: m.SupportTicketsPage })), 'AdminSupportTicketsPage')
const AdminSettingsPage        = lazyRetry(() => import('./features/admin/AdminSettingsPage').then(m => ({ default: m.AdminSettingsPage })), 'AdminSettingsPage')
const AdminMerchantsPage       = lazyRetry(() => import('./features/admin/MerchantApplicationsPage').then(m => ({ default: m.MerchantApplicationsPage })), 'AdminMerchantsPage')
const AdminOrdersPage          = lazyRetry(() => import('./features/admin/OrdersPage').then(m => ({ default: m.OrdersPage })), 'AdminOrdersPage')
const MerchantPayPage         = lazyRetry(() => import('./features/merchant/MerchantPayPage').then(m => ({ default: m.MerchantPayPage })), 'MerchantPayPage')
const MerchantApplyPage         = lazyRetry(() => import('./features/merchant/MerchantApplyPage').then(m => ({ default: m.MerchantApplyPage })), 'MerchantApplyPage')
const AdminTransactionsPage    = lazyRetry(() => import('./features/admin/TransactionsPage').then(m => ({ default: m.TransactionsPage })), 'AdminTransactionsPage')
const AdminSystemPage          = lazyRetry(() => import('./features/admin/SystemPage').then(m => ({ default: m.SystemPage })), 'AdminSystemPage')
const AdminAdminsPage          = lazyRetry(() => import('./features/admin/AdminsPage').then(m => ({ default: m.AdminsPage })), 'AdminAdminsPage')
const AdminStuckFundsPage      = lazyRetry(() => import('./features/admin/StuckFundsPage').then(m => ({ default: m.StuckFundsPage })), 'AdminStuckFundsPage')
import { syncBroadcastNotifications } from './lib/broadcastSync'
import { LoadingDots } from './components/ui/LoadingDots'

// A signed-in app open always goes lock screen → Home. Their code used to load
// one after the other, each only once the router reached it (a redirect, then
// a download, then the next). Start both now, alongside the app's own startup.
try {
  const p = window.location.pathname
  if (localStorage.getItem('meshport-auth-v4') && !p.startsWith('/paylink') && !p.startsWith(ADMIN_PATH)) {
    import('./features/auth/PasscodeSetup').catch(() => {})
    import('./features/home/HomePage').catch(() => {})
  }
} catch { /* private mode / no storage */ }

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 60 * 5, retry: 1 } },
})

/**
 * AuthGuard - strict onboarding gate.
 * Source of truth: Supabase users table (by wallet_address).
 * If wallet has a profile in Supabase, restore it and skip claim screen.
 */
function AuthGuard({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const isLocked = useAuthStore(s => s.isLocked)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const username = useAuthStore(s => s.username)
  const passcode = useAuthStore(s => s.passcode)
  const setUsername = useAuthStore(s => s.setUsername)
  const setUser = useAuthStore(s => s.setUser)
  const user = useAuthStore(s => s.user)
  const location = useLocation()
  const [checking, setChecking] = useState(false)
  // If username already in store from previous session, mark as checked immediately
  // This prevents the null flash where HomePage unmounts/remounts on every refresh
  const [checked, setChecked] = useState(() => !!useAuthStore.getState().username)

  // Check Supabase for existing profile by wallet address
  // This is the permanent identity lookup - runs once when wallet is available
  useEffect(() => {
    // If no walletAddress, mark as checked immediately - nothing to look up
    if (!walletAddress) { setChecked(true); return }
    if (checked) return  // only skip if already fetched this session
    setChecking(true)
    import('@/lib/supabase').then(({ getUserByWalletAddress }) => {
      getUserByWalletAddress(walletAddress).then(profile => {
        if (profile) {
          if (profile.username) setUsername(profile.username)
          // Always update user with fresh DB data - avatar, displayName etc
          const current = useAuthStore.getState().user
          if (current) {
            useAuthStore.getState().setUser({
              ...current,
              id:            profile.id,
              username:      profile.username ? profile.username + '.arc' : current.username,
              displayName:   profile.display_name || current.displayName,
              walletAddress: profile.wallet_address || current.walletAddress,
              // Cache-buster ensures browser loads fresh image, not cached old one
              avatar: profile.avatar_url
                ? profile.avatar_url.split('?')[0]  // no cache-buster - stable URL
                : null,
            })
          }
        }
        setChecking(false)
        setChecked(true)
      }).catch(() => { setChecking(false); setChecked(true) })
    })
  }, [walletAddress, username])

  if (!isAuthenticated) return <Navigate to="/auth" replace state={{ from: location }} />
  if (isLocked) return <Navigate to="/auth/lock" replace state={{ from: location }} />
  if (!passcode) return <Navigate to="/auth/passcode" replace />
  if (!walletAddress) return <Navigate to="/auth/wallet-setup" replace />
  // Wait for Supabase check before deciding on claim-username.
  // Shows the same blinking-dots state as the initial splash instead of a
  // blank flash, so the refresh reads as "loading" rather than a glitch.
  if (checking) return <LoadingDots />
  // Only block render if we have NO username AND haven't checked Supabase yet
  // If username is already in store (from previous session), show home immediately
  if (!username && !checked) return <LoadingDots />
  if (!username) return <Navigate to="/auth/claim-username" replace />
  // If user somehow ends up on an auth sub-route after completing onboarding, flush them to home
  if (location.pathname.startsWith('/auth/')) return <Navigate to="/" replace />
  return <>{children}</>
}

/**
 * RootGate - element for path '/'. A signed-out visitor landing on the bare
 * domain (meshport.xyz, no /landing needed) sees the public marketing page
 * directly at that URL instead of being bounced to /auth like every other
 * protected route. Only applies at the exact root path - visiting any other
 * app URL (e.g. /activity) while signed out still redirects to /auth via
 * AuthGuard below, unchanged. Once authenticated, '/' falls through to the
 * normal AppLayout/AuthGuard tree (children render HomePage via Outlet) -
 * same as before this existed.
 */
function RootGate() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const location = useLocation()
  // The installed app (home-screen PWA) is the product, not the website: a
  // signed-out user there goes straight to sign-in (AuthGuard → /auth). The
  // marketing landing page is for browser visitors only.
  const installed = useIsStandalone()
  if (!isAuthenticated && location.pathname === '/' && !installed) return <LandingPage />
  return <AuthGuard><AppLayout /></AuthGuard>
}

/**
 * ── Auth Route Guards ────────────────────────────────────────────────────────
 *
 * RULE: Once the user reaches home (/), pressing Back must NEVER return them
 * to any auth/onboarding page. We enforce this two ways:
 *
 * 1. Every guard that redirects uses `replace` - so auth pages are never
 *    pushed onto the browser history stack.
 *
 * 2. Each guard checks the FULL onboarding state and skips the user forward
 *    to wherever they actually belong, rather than just blocking the current page.
 *
 * Guard matrix (what each route checks):
 *
 *  /auth, /auth/google, /auth/email  →  RequireNoAuth
 *    - fully onboarded → /
 *    - partially through → next incomplete step
 *
 *  /auth/passcode  →  RequireNoPasscode
 *    - fully onboarded → /
 *    - passcode set → next step
 *    - not authenticated → /auth
 *
 *  /auth/wallet-setup, /auth/auto-wallet  →  RequireNoWallet
 *    - fully onboarded → /
 *    - wallet set → /auth/claim-username
 *    - no passcode → /auth/passcode
 *    - not authenticated → /auth
 *
 *  /auth/create-wallet, /auth/import-wallet  →  no route-level guard
 *    (they are multi-step flows; internal guards handle it)
 *
 *  /auth/claim-username  →  RequireNoUsername
 *    - fully onboarded → /
 *    - no wallet → /auth/wallet-setup
 *    - no passcode → /auth/passcode
 *    - not authenticated → /auth
 */

function isFullyOnboarded(s: ReturnType<typeof useAuthStore.getState>) {
  return !!(s.isAuthenticated && s.passcode && s.walletAddress && s.username)
}

// ── Auth Route Guards ─────────────────────────────────────────────────────────
// All guards use useAuthStore.getState() - one-time read, NO subscription.
// This prevents re-renders when store changes mid-flow (e.g. setWallet() during
// CreateWalletPage would re-trigger a reactive guard and interrupt the flow).

function RequireNoAuth({ children }: { children: React.ReactNode }) {
  const s = useAuthStore.getState()
  if (isFullyOnboarded(s)) return <Navigate to="/" replace />
  if (s.isAuthenticated && s.passcode && s.walletAddress) return <Navigate to="/auth/claim-username" replace />
  if (s.isAuthenticated && s.passcode) return <Navigate to="/auth/wallet-setup" replace />
  if (s.isAuthenticated) return <Navigate to="/auth/passcode" replace />
  return <>{children}</>
}

function RequireNoPasscode({ children }: { children: React.ReactNode }) {
  const s = useAuthStore.getState()
  // Returning email users land on /auth/passcode?returning=1 to set a new passcode.
  // They are fully onboarded (passcode + wallet + username all set from previous session)
  // so we MUST check for returning=1 BEFORE any redirect - otherwise the guard
  // sends them straight to / without letting them set a new passcode.
  const isReturning = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('returning') === '1'
  if (isReturning) {
    // Setting a NEW passcode over an existing one is only allowed straight
    // after a fresh sign-in (that flow also wipes this device's wallet copy).
    // Otherwise anyone holding a locked phone could open this URL, pick a new
    // PIN and get past the lock.
    let fresh = false
    try { fresh = Date.now() - Number(sessionStorage.getItem('mp_returning_signin') || 0) < 30 * 60_000 } catch { /* none */ }
    if (s.passcode && !fresh) return <Navigate to={!s.isAuthenticated ? '/auth' : s.isLocked ? '/auth/lock' : '/'} replace />
    return <>{children}</>
  }

  // All other cases: redirect forward if already onboarded
  if (isFullyOnboarded(s)) return <Navigate to="/" replace />
  if (s.passcode && s.walletAddress && s.username) return <Navigate to="/" replace />
  if (s.passcode && s.walletAddress) return <Navigate to="/auth/claim-username" replace />
  return <>{children}</>
}

function RequireNoWallet({ children }: { children: React.ReactNode }) {
  const s = useAuthStore.getState()
  if (!s.passcode) return <Navigate to="/auth/passcode" replace />
  if (isFullyOnboarded(s)) return <Navigate to="/" replace />
  if (s.walletAddress) return <Navigate to="/auth/claim-username" replace />
  return <>{children}</>
}

function RequireUnlocked({ children }: { children: React.ReactNode }) {
  const s = useAuthStore.getState()
  if (s.isAuthenticated && s.isLocked) return <Navigate to="/auth/lock" replace />
  return <>{children}</>
}

// A shared pay link opened by a signed-in user whose app is locked (a link
// opens a new tab, which locks): ask for the passcode first, then show the
// link. It used to show the pay page, hand over to the pay screen, get bounced
// to the lock screen there, and only then come back to the review.
function UnlockFirst({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const s = useAuthStore.getState()
  if (s.isAuthenticated && s.isLocked) return <Navigate to="/auth/lock" replace state={{ from: location }} />
  return <>{children}</>
}

function RequireNoUsername({ children }: { children: React.ReactNode }) {
  const s = useAuthStore.getState()
  if (!s.passcode) return <Navigate to="/auth/passcode" replace />
  if (!s.walletAddress) return <Navigate to="/auth/wallet-setup" replace />
  if (s.username) return <Navigate to="/" replace />
  return <>{children}</>
}


const router = createBrowserRouter([
  // ── Public auth routes ──────────────────────────────────────────────────────
  // Wrapped in AuthShell so the whole login/register flow stays phone-width
  // and centered on desktop instead of stretching full browser width.
  { path: '/auth',                element: <AuthShell><RequireNoAuth><LoginPage /></RequireNoAuth></AuthShell> },
  { path: '/auth/google',         element: <AuthShell><RequireNoAuth><GoogleAuthPage /></RequireNoAuth></AuthShell> },
  { path: '/auth/email',          element: <AuthShell><RequireNoAuth><EmailOTPPage /></RequireNoAuth></AuthShell> },
  { path: '/auth/passcode',       element: <AuthShell><RequireNoPasscode><PasscodeSetupPage /></RequireNoPasscode></AuthShell> },
  { path: '/auth/enable-biometric', element: <AuthShell><RequireUnlocked><EnableBiometricPage /></RequireUnlocked></AuthShell> },
  { path: '/auth/lock',           element: <AuthShell><PasscodeLockPage /></AuthShell> },
  { path: '/auth/auto-wallet',    element: <AuthShell><RequireNoWallet><AutoWalletPage /></RequireNoWallet></AuthShell> },
  { path: '/auth/wallet-setup',   element: <AuthShell><RequireNoWallet><WalletSetupPage /></RequireNoWallet></AuthShell> },
  { path: '/auth/create-wallet',  element: <AuthShell><CreateWalletPage /></AuthShell> },
  { path: '/auth/import-wallet',  element: <AuthShell><ImportWalletPage /></AuthShell> },
  { path: '/auth/claim-username', element: <AuthShell><RequireNoUsername><ClaimUsernamePage /></RequireNoUsername></AuthShell> },

  // ── Public payment page - no auth required ─────────────────────────────────
  // Also phone-width on desktop - this is the page a payment-receive link opens to.
  // Merchant payment request (QR / link) - public, no sign-in needed.
  { path: '/paylink/r/:code', element: <AuthShell><UnlockFirst><Unlocked title="Pay"><MerchantPayPage /></Unlocked></UnlockFirst></AuthShell> },
  { path: '/paylink/:username', element: <AuthShell><UnlockFirst><Unlocked title="Pay"><PayPage /></Unlocked></UnlockFirst></AuthShell> },
  // Old public link paths → /paylink/… (see RenamedPathRedirect).
  { path: '/pay/r/:code', element: <RenamedPathRedirect from="/pay" to="/paylink" /> },
  { path: '/pay/:username', element: <RenamedPathRedirect from="/pay" to="/paylink" /> },

  // Landing page lives at the bare root ('/', see RootGate below) for a
  // signed-out visitor - no separate /landing path needed or kept.

  // ── Public legal page - no auth required, so it can be linked from the
  //    registration screen before someone has an account ────────────────────
  { path: '/legal',   element: <AuthShell><TermsPrivacyPage /></AuthShell> },
  // Same page, direct links - Google's OAuth consent screen verification
  // wants a distinct URL for each document, not one combined page with
  // tabs. TermsPrivacyPage reads the path itself to land on the right tab.
  { path: '/terms',   element: <AuthShell><TermsPrivacyPage /></AuthShell> },
  { path: '/privacy', element: <AuthShell><TermsPrivacyPage /></AuthShell> },
  // Public Feature Guide - linked from the landing page, no account needed.
  { path: '/guide',   element: <div className="fixed inset-0 flex flex-col bg-bg"><FeatureGuidePage isPublic /></div> },
  // Google sends Circle sign-ins back here (src/wallet/circle.ts): outside
  // the app's gates, which could redirect away and lose the result in the URL.
  { path: '/wallet/circle-login', element: <CircleLoginReturnPage /> },

  // ── Admin Control Panel ──────────────────────────────────────────────────────
  { path: ADMIN_PATH, element: <Navigate to={`${ADMIN_PATH}/login`} replace /> },
  { path: `${ADMIN_PATH}/login`, element: <AdminLoginPage /> },
  {
    path: ADMIN_PATH,
    element: <AdminGuard><AdminLayout /></AdminGuard>,
    children: [
      { path: 'dashboard',   element: <AdminDashboardPage /> },
      { path: 'transactions', element: <AdminTransactionsPage /> },
      { path: 'system',      element: <AdminSystemPage /> },
      { path: 'admins',      element: <AdminAdminsPage /> },
      { path: 'features',    element: <AdminFeaturesPage /> },
      { path: 'coins',       element: <AdminCoinsPage /> },
      { path: 'chains',      element: <AdminChainsPage /> },
      { path: 'p2p',         element: <P2PAdminPage /> },
      { path: 'p2p/guide',   element: <P2PGuidePage /> },
      { path: 'treasury',    element: <TreasuryAdminPage /> },
      { path: 'analytics',   element: <AdminAnalyticsPage /> },
      { path: 'notifications', element: <NotificationBroadcastPage /> },
      { path: 'news',        element: <NewsAdminPage /> },
      { path: 'maintenance', element: <AdminMaintenancePage /> },
      { path: 'logs',        element: <AdminLogsPage /> },
      { path: 'support',     element: <AdminSupportTicketsPage /> },
      { path: 'stuck-funds', element: <AdminStuckFundsPage /> },
      { path: 'merchants',   element: <AdminMerchantsPage /> },
      { path: 'orders',      element: <AdminOrdersPage /> },
      { path: 'settings',    element: <AdminSettingsPage /> },
    ],
  },

  // ── Protected app routes - ALL inside AppLayout so BottomNav always renders ──
  {
    path: '/',
    element: <MaintenanceGate><RootGate /></MaintenanceGate>,
    children: [
      { index: true,                        element: <HomePage /> },
      { path: 'scanner',                    element: <Unlocked title="Scan"><FeatureGate feature="qr_payments_enabled"><ScannerPage /></FeatureGate></Unlocked> },
      {
        // Pathless layout wrapper - paths/params/navigation for these two
        // routes are unchanged, this only adds the desktop list+conversation
        // split view (mobile: renders exactly what was here before).
        element: <Unlocked title="Chats"><ChatDesktopSplit list={<FeatureGate feature="chat_enabled"><ChatListPage /></FeatureGate>} /></Unlocked>,
        children: [
          { path: 'chat',                     element: <FeatureGate feature="chat_enabled"><ChatListPage /></FeatureGate> },
          // Desktop: opens in the conversation column, the chat list stays.
          { path: 'chat/privacy',             element: <FeatureGate feature="chat_enabled"><ChatPrivacyPage /></FeatureGate> },
          { path: 'chat/new',                 element: <FeatureGate feature="chat_enabled"><ChatListPage newChat /></FeatureGate> },
          { path: 'chat/:id',                 element: <FeatureGate feature="chat_enabled"><ChatConversationPage /></FeatureGate> },
        ],
      },
      { path: 'activity',                   element: <ActivityPage /> },
      { path: 'notifications',              element: <FeatureGate feature="notifications_enabled"><NotificationsPage /></FeatureGate> },
      {
        // Settings and its pages - desktop: a Settings menu beside the page
        // (SettingsDesktopSplit); phones: exactly the pages as before.
        element: <SettingsDesktopSplit />,
        children: [
          { path: 'profile', element: <ProfilePage /> },
          { path: 'feature-guide', element: <FeatureGuidePage /> },
          { path: 'about', element: <AboutPage /> },
          { path: 'terms-privacy', element: <TermsPrivacyPage /> },
          { path: 'help-support', element: <HelpSupportPage /> },
          { path: 'security', element: <SecurityPage /> },
          { path: 'appearance', element: <AppearancePage /> },
          { path: 'security/change-passcode', element: <ChangePasscodePage /> },
          { path: 'backup', element: <FeatureGate feature="backup_wallet_enabled"><BackupPage /></FeatureGate> },
          { path: 'edit-profile', element: <EditProfilePage /> },
          { path: 'merchant', element: <MerchantApplyPage /> },
        ],
      },
      { path: 'insights',                   element: <Unlocked title="Insights"><InsightsPage /></Unlocked> },
      { path: 'pay',                        element: <Unlocked title="Pay"><FeatureGate feature="pay_send_enabled"><PaySendPage /></FeatureGate></Unlocked> },
      { path: 'pay-send',                   element: <RenamedPathRedirect from="/pay-send" to="/pay" /> },
      { path: 'receive',                    element: <Unlocked title="Receive"><FeatureGate feature="receive_enabled"><ReceivePage /></FeatureGate></Unlocked> },
      { path: 'receive/requests',           element: <Unlocked title="Requests"><FeatureGate feature="receive_enabled"><MyRequestsPage /></FeatureGate></Unlocked> },
      { path: 'rewards',                    element: <Unlocked title="Rewards"><PersonalOnly><FeatureGate feature="rewards_enabled"><RewardsPage /></FeatureGate></PersonalOnly></Unlocked> },
      { path: 'business',                   element: <BusinessPage /> },
      { path: 'recent-paid',                element: <Unlocked title="Recent"><RecentPaidPage /></Unlocked> },
      { path: 'asset/:token',               element: <Unlocked title="Asset"><AssetPage /></Unlocked> },
      { path: 'news',                       element: <Unlocked title="News"><NewsPage /></Unlocked> },
      { path: 'news/:id',                   element: <Unlocked title="News"><NewsArticlePage /></Unlocked> },
      { path: 'bulk-payout',                element: <Unlocked title="Bulk Pay"><FeatureGate feature="bulk_payments_enabled"><BulkPayoutPage /></FeatureGate></Unlocked> },
      { path: 'multichain',                 element: <Unlocked title="Multichain"><MultichainPage /></Unlocked> },
      { path: 'multichain-recovery',        element: <Unlocked title="Multichain"><MultichainRecoveryPage /></Unlocked> },
      // Old standalone Transfer / Claim pages are gone - both live inside the
      // Multichain Hub now. Old links (notifications, bookmarks) land on the
      // matching Hub tab, keeping ?claim= / ?chain= / ?scannedAddress=.
      { path: 'multichain-transfer',        element: <LegacyMultichainRedirect tab="transfer" /> },
      { path: 'multichain-claim',           element: <LegacyMultichainRedirect tab="bring" /> },
      // Only the "start something new" surfaces are gated - browsing offers,
      // creating one, or accepting one. Deliberately NOT gating
      // trade/:tradeId, my-trades, my-offers, or history: someone with money
      // already in an active trade needs to be able to keep managing it
      // (mark paid, chat, cancel, view status) even while P2P is disabled
      // for new activity - especially now that notifications and the Home
      // popups deep-link straight to /p2p/trade/:tradeId, which would
      // otherwise strand people the moment they tap one during a disable.
      { path: 'p2p',                        element: <Unlocked title="P2P"><FeatureGate feature="p2p_enabled"><P2PHubPage /></FeatureGate></Unlocked> },
      { path: 'p2p/create',                 element: <Unlocked title="P2P"><FeatureGate feature="p2p_enabled"><P2PCreateOfferPage /></FeatureGate></Unlocked> },
      { path: 'p2p/offer/:offerId',         element: <Unlocked title="P2P"><FeatureGate feature="p2p_enabled"><P2POfferDetailPage /></FeatureGate></Unlocked> },
      { path: 'p2p/trade/:tradeId',         element: <Unlocked title="P2P"><P2PTradePage /></Unlocked> },
      { path: 'p2p/my-offers',              element: <Unlocked title="P2P"><P2PMyOffersPage /></Unlocked> },
      { path: 'p2p/my-trades',              element: <Unlocked title="P2P"><P2PMyTradesPage /></Unlocked> },
      { path: 'p2p/history',                element: <Unlocked title="P2P"><P2PHistoryPage /></Unlocked> },
      { path: 'circle-wallet',              element: <Unlocked title="Circle wallet"><CircleWalletPage /></Unlocked> },
      { path: 'swap',                        element: <Unlocked title="Swap"><FeatureGate feature="swap_enabled"><SwapPage /></FeatureGate></Unlocked> },
      { path: 'activity/:id',               element: <TransactionDetailPage /> },
    ],
  },
  { path: '*',                 element: <Navigate to="/" replace /> },
].map(r => ({ ...r, errorElement: <RouteErrorPage /> })))

// Fades out and removes index.html's splash once the first real page is on
// screen. It sits inside the same Suspense boundary as the router, so it only
// mounts after the first page's code has loaded - the splash used to go away
// as soon as the store hydrated, leaving a blank loading screen (looked like
// an empty Home) while the lock screen's code was still downloading.
// It also waits for the page to actually draw something: the first route is
// often just a redirect (e.g. "/" → the lock screen), which renders nothing
// while the next page's code is still loading.
// Was 1200ms: with the logo's glide after it, Face ID / fingerprint only came
// up ~1.8s after tapping the app icon.
const MIN_OPEN_SPLASH_MS = 450
function SplashRemover() {
  useEffect(() => {
    const splash = document.getElementById('splash')
    const root = document.getElementById('root')
    if (!splash || !root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const hasPage = () => root.innerText.trim().length > 0 || !!root.querySelector('svg, img, canvas, input, button')
    // A real app open (not a refresh) holds the opening screen for a moment,
    // so the app settles underneath and the lock screen (and its fingerprint
    // / Face ID prompt) comes up once, cleanly, instead of flickering in.
    const freshOpen = !document.documentElement.classList.contains('mp-refresh')
    const shownUntil = freshOpen ? MIN_OPEN_SPLASH_MS : 0
    let hidden = false
    const hide = () => {
      // The first screen is on: the app shell is interactive (lib/perfTrace).
      void import('./lib/perfTrace').then(m => m.markStartup('shell')).catch(() => {})
      if (hidden) return
      obs.disconnect()
      const wait = shownUntil - performance.now()
      if (wait > 0) { timer = setTimeout(hide, wait); return }
      hidden = true
      // The lock screen is on screen now: let the fingerprint / Face ID
      // prompt open while the logo glides, not after it has finished.
      markSplashDone()
      document.getElementById('mp-splash-theme')?.remove() // back to the app's own status bar colour
      try { sessionStorage.setItem('mp_opened', '1') } catch { /* private mode */ }
      // App open onto the lock screen: the opening logo glides into the lock
      // screen's own logo while the teal fades away - one continuous logo, no
      // empty teal frame and no jump from the middle to the top.
      const tile = splash.querySelector<HTMLElement>('.tile')
      const target = root.querySelector<HTMLElement>('[data-splash-target]')
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (freshOpen && tile && target && !reduced) {
        const a = tile.getBoundingClientRect()
        if (a.width > 0 && target.getBoundingClientRect().width > 0) {
          // Drawn frame by frame, re-reading the target each frame: the lock
          // screen can still shift its layout for a moment (the fingerprint
          // check answering), and the logo must land exactly on it.
          const FLY_MS = 380
          const base = getComputedStyle(tile).transform
          const ease = (t: number) => 1 - Math.pow(1 - t, 3)
          target.style.visibility = 'hidden'
          // The lock screen appears around the logo once it has landed (it
          // isn't laid out any differently - just not shown yet), so the logo
          // never slides over its text on the way up.
          root.style.opacity = '0'
          const pageBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || 'transparent'
          // Freeze the opening logo as it is now, then let the page take its own
          // background (behind the splash) - so nothing jumps or turns teal
          // again when the opening-screen styles go.
          const mark = tile.querySelector<HTMLElement>('.mark')
          const tcs = getComputedStyle(tile), mcs = mark ? getComputedStyle(mark) : null
          Object.assign(tile.style, { width: tcs.width, height: tcs.height, borderRadius: tcs.borderRadius })
          if (mark && mcs) Object.assign(mark.style, { width: mcs.width, height: mcs.height })
          const txt = splash.querySelector<HTMLElement>('.txt')
          if (txt) txt.style.display = 'none'
          document.documentElement.classList.remove('mp-opening')
          tile.style.transformOrigin = 'center'
          splash.style.transition = `background-color ${FLY_MS}ms ease`
          splash.style.pointerEvents = 'none'
          // Timed from the first frame it draws, never from before it: a
          // frame's timestamp can be earlier than performance.now() here (by a
          // lot on a slow phone), and a negative progress made the logo jump
          // down and grow for a frame before gliding up.
          let start = -1
          const frame = (now: number) => {
            if (start < 0) start = now
            const t = Math.min(1, Math.max(0, (now - start) / FLY_MS)), k = ease(t)
            const r = target.getBoundingClientRect()
            const dx = (r.left + r.width / 2) - (a.left + a.width / 2)
            const dy = (r.top + r.height / 2) - (a.top + a.height / 2)
            const sc = 1 + (r.width / a.width - 1) * k
            tile.style.transform = `${base === 'none' ? '' : base} translate(${dx * k}px, ${dy * k}px) scale(${sc})`
            if (t < 1) { requestAnimationFrame(frame); return }
            // Landed: the page fades in under the (still shown) logo, then the
            // page's own logo takes over in the same place.
            splash.style.transition = 'none'
            splash.style.backgroundColor = 'transparent'
            root.style.opacity = ''
            root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
            timer = setTimeout(() => { target.style.visibility = ''; splash.remove(); markSplashDone() }, 190)
          }
          requestAnimationFrame(now => { splash.style.backgroundColor = pageBg; frame(now) })
          return
        }
      }
      splash.classList.add('splash-hide')
      document.documentElement.classList.remove('mp-opening') // and the page's own background
      timer = setTimeout(() => { splash.remove(); markSplashDone() }, 250)
    }
    const obs = new MutationObserver(() => { if (hasPage()) hide() })
    if (hasPage()) hide()
    else {
      obs.observe(root, { childList: true, subtree: true, characterData: true })
      // Never keep the splash forever (boot.js handles a genuinely stuck load).
      timer = setTimeout(hide, 8000)
    }
    return () => { obs.disconnect(); if (timer) clearTimeout(timer) }
  }, [])
  return null
}

export default function App() {
  // Open the wallet on app load / reload. The key lives in the wallet frame
  // (src/wallet); its session / device copy reopens it without a prompt, so
  // ask as soon as a wallet address is known. Mounting the frame here also
  // warms it up before the first signature is needed.
  // NOTE: Auth store persist is async (createJSONStorage wraps localStorage in Promises),
  // so walletAddress may be null on the first render. We subscribe to the
  // auth store and restore as soon as walletAddress becomes available.
  useEffect(() => {
    const tryRestore = (walletAddress: string | null, signer: unknown) => {
      if (walletAddress && !signer && !useAuthStore.getState().isLocked) {
        import('./lib/restoreWallet').then(({ restorePrivateKey }) => {
          restorePrivateKey().then(ok => {
          }).catch(() => {})
        })
      }
    }

    // Try immediately (works if auth store was already rehydrated synchronously)
    const s = useAuthStore.getState()
    tryRestore(s.walletAddress, s.signer)

    const unsub = useAuthStore.subscribe((state, prevState) => {
      if (state.walletAddress && !prevState.walletAddress) {
        tryRestore(state.walletAddress, state.signer)
        unsub()
      }
    })
    return unsub
  }, [])

  // No lock for being offline: losing signal (lifts, metro, 4G/5G hand-over)
  // isn't a reason to throw the open wallet away - MetaMask and Phantom don't.
  // The app still locks on a fresh launch and after 15 min in the background.


  // ── Auto-lock instantly when the browser was actually closed ─────────────
  // The old 15-minute inactivity timer is gone - the app no longer locks
  // just because someone stepped away with the tab open. Instead, this
  // locks instantly the moment a genuinely NEW browser session starts,
  // using a sessionStorage flag as the signal:
  //   - sessionStorage is per-tab and is wiped by the browser the instant
  //     that tab/window is actually closed - it does NOT survive a real
  //     close, so its absence on the next mount means "the browser was
  //     closed since we were last here."
  //   - sessionStorage DOES survive: a manual refresh (F5 / Cmd+R), and
  //     every window.location.reload() the app itself performs - the
  //     stale-deployment-chunk retry in lib/lazyRetry.ts and the
  //     background-suspension recovery reload below both reload the SAME
  //     tab, so the flag is still there and no lock is triggered.
  // Net effect: refreshing or an app update never locks the wallet, but
  // closing the browser (or tab) and reopening it does, immediately -
  // no need to wait out a timer first. `isLocked` is persisted, so once
  // locked, editing the URL can't bypass /auth/lock, and unlocking there
  // always works the normal way regardless of whether an update/reload
  // just happened.
  // The check itself now runs in main.tsx, before the first render, so a
  // fresh launch goes straight from the splash to the lock screen instead
  // of painting Home first.

  // ── Recover from long background suspension ────────────────────────────
  // Mobile browsers/PWAs aggressively suspend backgrounded tabs - timers
  // freeze and, critically, the Supabase Realtime WebSocket connection can
  // get silently killed by the OS without ever firing a 'close' event the
  // app could react to. The result: coming back to the app after a while
  // away can leave it looking "stuck" - no new messages/balance updates
  // arrive, because the app has no idea its realtime connection is dead.
  // After a while away: reconnect realtime if it's down and reload the data
  // in place (useOnReconnect). This used to reload the whole page, which
  // also threw away the open wallet - wallet apps keep it open until their
  // own auto-lock. Short backgrounds (switching apps briefly) do nothing.
  useEffect(() => {
    let hiddenAt: number | null = null
    const STALE_AFTER_MS = 2 * 60 * 1000 // 2 minutes
    const AUTO_LOCK_AFTER_MS = 15 * 60 * 1000 // 15 minutes hidden - same value in main.tsx
    const HIDDEN_AT_KEY = 'meshport:hidden-at'

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        // Kept in sessionStorage too: if the phone discards the tab while
        // it's in the background, main.tsx reads this on the reload and
        // locks before anything is drawn.
        try { sessionStorage.setItem(HIDDEN_AT_KEY, String(hiddenAt)) } catch { /* private mode */ }
        return
      }
      if (document.visibilityState === 'visible' && hiddenAt) {
        const awayMs = Date.now() - hiddenAt
        hiddenAt = null
        try { sessionStorage.removeItem(HIDDEN_AT_KEY) } catch { /* private mode */ }
        // Auto-lock after a long time in the background (like other wallets
        // do), so a phone left unattended doesn't stay unlocked for hours.
        if (awayMs > AUTO_LOCK_AFTER_MS) {
          const { isAuthenticated, passcodeLockEnabled, isLocked, lock } = useAuthStore.getState()
          if (isAuthenticated && passcodeLockEnabled && !isLocked) {
            // Hide the app in this same event, before the next frame, so the
            // page underneath never shows before the lock screen does (the
            // lock screen removes this class when it mounts).
            document.documentElement.classList.add('mp-locking')
            lock()
          }
        }
        // Back after a while: reload the data in place (chats, balance,
        // activity - everything that reloads on reconnect). Never the page:
        // a page reload threw the open wallet away, so it was cold - or
        // 'Couldn't access your wallet' - right when the person came back.
        // A new app version waits for the next launch.
        if (awayMs > STALE_AFTER_MS) {
          // A socket the phone killed silently is also caught by realtime's
          // own heartbeat; this just doesn't wait for it.
          void import('./lib/supabase').then(({ supabase }) => { if (!supabase.realtime.isConnected()) supabase.realtime.connect() }).catch(() => {})
          void import('./lib/connectivity').then(m => m.refreshAfterResume())
        }
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  // ── Load feature flags from Admin Control Panel + subscribe to live changes ──
  useEffect(() => {
    useSettingsStore.getState().load()
    const stop = useSettingsStore.getState().startRealtime()
    return stop
  }, [])
  // Opened without internet (or the load timed out) → load again once it's back.
  useOnReconnect(() => { void useSettingsStore.getState().load() })

  // ── Admin-disabled Biometric Login is enforced globally, not just on the
  // Security settings page - if an admin flips this off while a user already
  // has it turned on, it's forced off for that user immediately (live, via
  // the realtime settings subscription above), and the user has no way to
  // turn it back on until an admin re-enables it (SecurityPage disables the
  // toggle itself when this flag is off).
  useEffect(() => {
    const enforce = () => {
      const adminEnabled = useSettingsStore.getState().isEnabled('biometric_login_enabled', true)
      if (!adminEnabled && useAuthStore.getState().biometricEnabled) {
        useAuthStore.getState().setBiometricEnabled(false)
      }
    }
    enforce()
    const unsub = useSettingsStore.subscribe(enforce)
    return unsub
  }, [])

  // ── Sync admin broadcast announcements into the in-app Notifications list ──
  // Runs independently of OS push permission/subscription state, so every
  // user sees announcements the next time they open the app, even if push
  // was never enabled (or can't be, e.g. iOS Safari not added to Home Screen).
  useEffect(() => {
    // Announcements can wait on a very slow network (the balance goes first).
    const sync = () => { if (!isSlowNetwork()) syncBroadcastNotifications(useAuthStore.getState().walletAddress) }
    sync()
    const interval = setInterval(sync, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') sync() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [useAuthStore(s => s.user?.id)])

  // ── Push notifications: on by default for every account ───────────────────
  // Notifications should never require a manual "enable" step from the user -
  // every account gets them turned on automatically the moment it's created,
  // imported, or logged into. This subscribes (or re-saves the subscription
  // server-side if one already exists) any time we have a signed-in user.
  useEffect(() => {
    const userId = useAuthStore.getState().user?.id
    if (!userId) return
    // Waits for a usable network (on a very slow one the balance goes first).
    return whenNetworkOk(() => { import('./lib/pushNotifications').then(({ enablePushNotifications }) => {
      // Renew the subscription at most once a day: the push service can
      // revoke one (reinstall, data cleared) while the browser still hands
      // back the old object, and pushes to it silently go nowhere.
      let fresh = false
      try { fresh = Date.now() - Number(localStorage.getItem('mp_push_fresh_at') || 0) > 24 * 3600_000 } catch { /* ignore */ }
      enablePushNotifications(userId, { fresh }).then(r => {
        if (r.ok && fresh) { try { localStorage.setItem('mp_push_fresh_at', String(Date.now())) } catch { /* ignore */ } }
      }).catch(() => {})
    }) })
  }, [useAuthStore(s => s.user?.id)])

  // ── Wait for Zustand auth store to rehydrate from localStorage ────────────
  // Without this, the router renders immediately with empty state and causes
  // flash of wrong page (login screen on refresh while logged in, or vice versa).
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    // Zustand persist with localStorage is synchronous - rehydration happens
    // before first render but useLayoutEffect fires after. Using a small
    // microtask delay ensures store is populated before we render routes.
    const t = setTimeout(() => setHydrated(true), 0)
    return () => clearTimeout(t)
  }, [])

  // index.html's inline splash (animated logo) is still visible underneath
  // during this gap, so nothing needs to render here - avoids a double loader.
  if (!hydrated) return null

  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<LoadingDots />}>
        {/* Navigations render in a transition: while a page's code is still
            loading, the current page stays on screen (no blank loader flash
            between pages). */}
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
        <SplashRemover />
        <OfflineBanner />
        {/* Privy wallets for Google / email accounts (src/wallet/privy.ts) */}
        <PrivyGate />
      </Suspense>
    </QueryClientProvider>
  )
}