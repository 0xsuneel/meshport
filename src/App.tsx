import { useState, useEffect, Suspense } from 'react'
import { createBrowserRouter, RouterProvider, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from './store'
import { AppLayout } from './components/layout/AppLayout'
import { AuthShell } from './components/layout/AuthShell'
import { ChatDesktopSplit } from './components/layout/ChatDesktopSplit'
import { ADMIN_PATH } from './lib/adminPath'
import { lazyRetry } from './lib/lazyRetry'

// ── Lazy-loaded pages ────────────────────────────────────────────────────────
// Every page below used to be a static top-level import, meaning the entire
// app — Home, Chat, Multichain, the whole Admin panel, everything — was
// bundled together into one chunk that had to be downloaded and parsed
// before ANY route could render. That's especially costly for pages meant to
// be opened cold by strangers from an external link — like a payment link
// (/pay/:username) — where someone was paying the full cost of the entire
// app just to see a small landing page. Wrapping each page in lazyRetry()
// gives every route its own small chunk, so visiting one route no longer
// forces a download of all the others — and auto-recovers (one reload) if a
// route's chunk went stale because a new version was deployed while someone
// already had the app open, instead of showing a broken error screen.
const HomePage             = lazyRetry(() => import('./features/home/HomePage').then(m => ({ default: m.HomePage })), 'HomePage')
const PaySendPage              = lazyRetry(() => import('./features/paysend/PaySendPage').then(m => ({ default: m.PaySendPage })), 'PaySendPage')
const MultichainTransferPage    = lazyRetry(() => import('./features/multichain/MultichainTransferPage').then(m => ({ default: m.MultichainTransferPage })), 'MultichainTransferPage')
const MultichainClaimPage   = lazyRetry(() => import('./features/multichain/MultichainClaimPage').then(m => ({ default: m.MultichainClaimPage })), 'MultichainClaimPage')
const P2PHubPage            = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PHubPage })), 'P2PHubPage')
const P2PCreateOfferPage    = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PCreateOfferPage })), 'P2PCreateOfferPage')
const P2POfferDetailPage    = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2POfferDetailPage })), 'P2POfferDetailPage')
const P2PTradePage          = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PTradePage })), 'P2PTradePage')
const P2PMyOffersPage       = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PMyOffersPage })), 'P2PMyOffersPage')
const P2PMyTradesPage       = lazyRetry(() => import('./features/p2p/P2PPage').then(m => ({ default: m.P2PMyTradesPage })), 'P2PMyTradesPage')
const P2PHistoryPage        = lazyRetry(() => import('./features/p2p/HistoryPage').then(m => ({ default: m.P2PHistoryPage })), 'P2PHistoryPage')
const MultichainPage        = lazyRetry(() => import('./features/multichain/MultichainPage').then(m => ({ default: m.MultichainPage })), 'MultichainPage')
const ReceivePage           = lazyRetry(() => import('./features/receive/ReceivePage').then(m => ({ default: m.ReceivePage })), 'ReceivePage')
const ScannerPage           = lazyRetry(() => import('./features/scanner/ScannerPage').then(m => ({ default: m.ScannerPage })), 'ScannerPage')
const ChatListPage          = lazyRetry(() => import('./features/chat/ChatPage').then(m => ({ default: m.ChatListPage })), 'ChatListPage')
const ChatConversationPage  = lazyRetry(() => import('./features/chat/ChatPage').then(m => ({ default: m.ChatConversationPage })), 'ChatConversationPage')
const ActivityPage          = lazyRetry(() => import('./features/activity/ActivityPage').then(m => ({ default: m.ActivityPage })), 'ActivityPage')
const TransactionDetailPage = lazyRetry(() => import('./features/activity/TransactionDetail').then(m => ({ default: m.TransactionDetailPage })), 'TransactionDetailPage')
const TreasuryPage          = lazyRetry(() => import('./features/treasury/TreasuryPage').then(m => ({ default: m.TreasuryPage })), 'TreasuryPage')
const InsightsPage          = lazyRetry(() => import('./features/insights/InsightsPage').then(m => ({ default: m.InsightsPage })), 'InsightsPage')
const RewardsPage           = lazyRetry(() => import('./features/rewards/RewardsPage').then(m => ({ default: m.RewardsPage })), 'RewardsPage')
const RecentPaidPage        = lazyRetry(() => import('./features/recent/RecentPaidPage').then(m => ({ default: m.RecentPaidPage })), 'RecentPaidPage')
const BulkPayoutPage        = lazyRetry(() => import('./features/bulkpayout/BulkPayoutPage').then(m => ({ default: m.BulkPayoutPage })), 'BulkPayoutPage')
const ProfilePage           = lazyRetry(() => import('./features/profile/ProfilePage').then(m => ({ default: m.ProfilePage })), 'ProfilePage')
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
// possible — it's the page a brand-new visitor (no session, nothing cached)
// lands on cold from an external payment link, so it's imported eagerly
// rather than lazily: for THIS specific route, avoiding an extra
// lazy-chunk network round-trip on top of the initial page load matters
// more than shaving bytes off the main bundle.
import { PayPage } from './features/pay/PayPage'
import { useSettingsStore } from './store/settingsStore'
import { FeatureGate } from './components/admin/FeatureGate'
import { MaintenanceGate } from './components/admin/MaintenanceGate'
import { AdminGuard } from './features/admin/AdminGuard'
const AdminLoginPage           = lazyRetry(() => import('./features/admin/AdminLoginPage').then(m => ({ default: m.AdminLoginPage })), 'AdminLoginPage')
const AdminLayout              = lazyRetry(() => import('./features/admin/AdminLayout').then(m => ({ default: m.AdminLayout })), 'AdminLayout')
const AdminDashboardPage       = lazyRetry(() => import('./features/admin/DashboardPage').then(m => ({ default: m.DashboardPage })), 'AdminDashboardPage')
const AdminFeaturesPage        = lazyRetry(() => import('./features/admin/FeaturesPage').then(m => ({ default: m.FeaturesPage })), 'AdminFeaturesPage')
const AdminCoinsPage           = lazyRetry(() => import('./features/admin/CoinsPage').then(m => ({ default: m.CoinsPage })), 'AdminCoinsPage')
const AdminChainsPage          = lazyRetry(() => import('./features/admin/ChainsPage').then(m => ({ default: m.ChainsPage })), 'AdminChainsPage')
const P2PAdminPage             = lazyRetry(() => import('./features/p2p/P2PAdminPage').then(m => ({ default: m.P2PAdminPage })), 'P2PAdminPage')
const TreasuryAdminPage        = lazyRetry(() => import('./features/admin/TreasuryAdminPage').then(m => ({ default: m.TreasuryAdminPage })), 'TreasuryAdminPage')
const AdminAnalyticsPage       = lazyRetry(() => import('./features/admin/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })), 'AdminAnalyticsPage')
const NotificationBroadcastPage = lazyRetry(() => import('./features/admin/NotificationBroadcastPage').then(m => ({ default: m.NotificationBroadcastPage })), 'NotificationBroadcastPage')
const AdminMaintenancePage     = lazyRetry(() => import('./features/admin/MaintenancePage').then(m => ({ default: m.MaintenancePage })), 'AdminMaintenancePage')
const AdminLogsPage            = lazyRetry(() => import('./features/admin/LogsPage').then(m => ({ default: m.LogsPage })), 'AdminLogsPage')
const AdminSupportTicketsPage  = lazyRetry(() => import('./features/admin/SupportTicketsPage').then(m => ({ default: m.SupportTicketsPage })), 'AdminSupportTicketsPage')
const AdminSettingsPage        = lazyRetry(() => import('./features/admin/AdminSettingsPage').then(m => ({ default: m.AdminSettingsPage })), 'AdminSettingsPage')
import { syncBroadcastNotifications } from './lib/broadcastSync'
import { LoadingDots } from './components/ui/LoadingDots'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 60 * 5, retry: 1 } },
})

/**
 * AuthGuard — strict onboarding gate.
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
  // This is the permanent identity lookup — runs once when wallet is available
  useEffect(() => {
    // If no walletAddress, mark as checked immediately — nothing to look up
    if (!walletAddress) { setChecked(true); return }
    if (checked) return  // only skip if already fetched this session
    setChecking(true)
    import('@/lib/supabase').then(({ getUserByWalletAddress }) => {
      getUserByWalletAddress(walletAddress).then(profile => {
        if (profile) {
          if (profile.username) setUsername(profile.username)
          // Always update user with fresh DB data — avatar, displayName etc
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
                ? profile.avatar_url.split('?')[0]  // no cache-buster — stable URL
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
 * RootGate — element for path '/'. A signed-out visitor landing on the bare
 * domain (meshport.xyz, no /landing needed) sees the public marketing page
 * directly at that URL instead of being bounced to /auth like every other
 * protected route. Only applies at the exact root path — visiting any other
 * app URL (e.g. /activity) while signed out still redirects to /auth via
 * AuthGuard below, unchanged. Once authenticated, '/' falls through to the
 * normal AppLayout/AuthGuard tree (children render HomePage via Outlet) —
 * same as before this existed.
 */
function RootGate() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const location = useLocation()
  if (!isAuthenticated && location.pathname === '/') return <LandingPage />
  return <AuthGuard><AppLayout /></AuthGuard>
}

/**
 * ── Auth Route Guards ────────────────────────────────────────────────────────
 *
 * RULE: Once the user reaches home (/), pressing Back must NEVER return them
 * to any auth/onboarding page. We enforce this two ways:
 *
 * 1. Every guard that redirects uses `replace` — so auth pages are never
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
// All guards use useAuthStore.getState() — one-time read, NO subscription.
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
  // so we MUST check for returning=1 BEFORE any redirect — otherwise the guard
  // sends them straight to / without letting them set a new passcode.
  const isReturning = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('returning') === '1'
  if (isReturning) return <>{children}</>

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
  { path: '/auth/enable-biometric', element: <AuthShell><EnableBiometricPage /></AuthShell> },
  { path: '/auth/lock',           element: <AuthShell><PasscodeLockPage /></AuthShell> },
  { path: '/auth/auto-wallet',    element: <AuthShell><RequireNoWallet><AutoWalletPage /></RequireNoWallet></AuthShell> },
  { path: '/auth/wallet-setup',   element: <AuthShell><RequireNoWallet><WalletSetupPage /></RequireNoWallet></AuthShell> },
  { path: '/auth/create-wallet',  element: <AuthShell><CreateWalletPage /></AuthShell> },
  { path: '/auth/import-wallet',  element: <AuthShell><ImportWalletPage /></AuthShell> },
  { path: '/auth/claim-username', element: <AuthShell><RequireNoUsername><ClaimUsernamePage /></RequireNoUsername></AuthShell> },

  // ── Public payment page — no auth required ─────────────────────────────────
  // Also phone-width on desktop — this is the page a payment-receive link opens to.
  { path: '/pay/:username', element: <AuthShell><PayPage /></AuthShell> },

  // Landing page lives at the bare root ('/', see RootGate below) for a
  // signed-out visitor — no separate /landing path needed or kept.

  // ── Public legal page — no auth required, so it can be linked from the
  //    registration screen before someone has an account ────────────────────
  { path: '/legal',   element: <AuthShell><TermsPrivacyPage /></AuthShell> },
  // Same page, direct links — Google's OAuth consent screen verification
  // wants a distinct URL for each document, not one combined page with
  // tabs. TermsPrivacyPage reads the path itself to land on the right tab.
  { path: '/terms',   element: <AuthShell><TermsPrivacyPage /></AuthShell> },
  { path: '/privacy', element: <AuthShell><TermsPrivacyPage /></AuthShell> },

  // ── Admin Control Panel ──────────────────────────────────────────────────────
  { path: ADMIN_PATH, element: <Navigate to={`${ADMIN_PATH}/login`} replace /> },
  { path: `${ADMIN_PATH}/login`, element: <AdminLoginPage /> },
  {
    path: ADMIN_PATH,
    element: <AdminGuard><AdminLayout /></AdminGuard>,
    children: [
      { path: 'dashboard',   element: <AdminDashboardPage /> },
      { path: 'features',    element: <AdminFeaturesPage /> },
      { path: 'coins',       element: <AdminCoinsPage /> },
      { path: 'chains',      element: <AdminChainsPage /> },
      { path: 'p2p',         element: <P2PAdminPage /> },
      { path: 'treasury',    element: <TreasuryAdminPage /> },
      { path: 'analytics',   element: <AdminAnalyticsPage /> },
      { path: 'notifications', element: <NotificationBroadcastPage /> },
      { path: 'maintenance', element: <AdminMaintenancePage /> },
      { path: 'logs',        element: <AdminLogsPage /> },
      { path: 'support',     element: <AdminSupportTicketsPage /> },
      { path: 'settings',    element: <AdminSettingsPage /> },
    ],
  },

  // ── Protected app routes — ALL inside AppLayout so BottomNav always renders ──
  {
    path: '/',
    element: <MaintenanceGate><RootGate /></MaintenanceGate>,
    children: [
      { index: true,                        element: <HomePage /> },
      { path: 'scanner',                    element: <FeatureGate feature="qr_payments_enabled"><ScannerPage /></FeatureGate> },
      {
        // Pathless layout wrapper — paths/params/navigation for these two
        // routes are unchanged, this only adds the desktop list+conversation
        // split view (mobile: renders exactly what was here before).
        element: <ChatDesktopSplit list={<FeatureGate feature="chat_enabled"><ChatListPage /></FeatureGate>} />,
        children: [
          { path: 'chat',                     element: <FeatureGate feature="chat_enabled"><ChatListPage /></FeatureGate> },
          { path: 'chat/:id',                 element: <FeatureGate feature="chat_enabled"><ChatConversationPage /></FeatureGate> },
        ],
      },
      { path: 'activity',                   element: <ActivityPage /> },
      { path: 'treasury',                   element: <FeatureGate feature="treasury_enabled"><TreasuryPage /></FeatureGate> },
      { path: 'insights',                   element: <InsightsPage /> },
      { path: 'pay-send',                   element: <FeatureGate feature="pay_send_enabled"><PaySendPage /></FeatureGate> },
      { path: 'receive',                    element: <FeatureGate feature="receive_enabled"><ReceivePage /></FeatureGate> },
      { path: 'rewards',                    element: <FeatureGate feature="rewards_enabled"><RewardsPage /></FeatureGate> },
      { path: 'recent-paid',                element: <RecentPaidPage /> },
      { path: 'bulk-payout',                element: <FeatureGate feature="bulk_payments_enabled"><BulkPayoutPage /></FeatureGate> },
      { path: 'multichain',                 element: <MultichainPage /> },
      { path: 'multichain-transfer',            element: <FeatureGate feature="transfer_enabled"><MultichainTransferPage /></FeatureGate> },
      { path: 'multichain-claim',           element: <FeatureGate feature="claim_enabled"><MultichainClaimPage /></FeatureGate> },
      // Only the "start something new" surfaces are gated — browsing offers,
      // creating one, or accepting one. Deliberately NOT gating
      // trade/:tradeId, my-trades, my-offers, or history: someone with money
      // already in an active trade needs to be able to keep managing it
      // (mark paid, chat, cancel, view status) even while P2P is disabled
      // for new activity — especially now that notifications and the Home
      // popups deep-link straight to /p2p/trade/:tradeId, which would
      // otherwise strand people the moment they tap one during a disable.
      { path: 'p2p',                        element: <FeatureGate feature="p2p_enabled"><P2PHubPage /></FeatureGate> },
      { path: 'p2p/create',                 element: <FeatureGate feature="p2p_enabled"><P2PCreateOfferPage /></FeatureGate> },
      { path: 'p2p/offer/:offerId',         element: <FeatureGate feature="p2p_enabled"><P2POfferDetailPage /></FeatureGate> },
      { path: 'p2p/trade/:tradeId',         element: <P2PTradePage /> },
      { path: 'p2p/my-offers',              element: <P2PMyOffersPage /> },
      { path: 'p2p/my-trades',              element: <P2PMyTradesPage /> },
      { path: 'p2p/history',                element: <P2PHistoryPage /> },
      { path: 'profile',                    element: <ProfilePage /> },
      { path: 'feature-guide',              element: <FeatureGuidePage /> },
      { path: 'about',                      element: <AboutPage /> },
      { path: 'terms-privacy',              element: <TermsPrivacyPage /> },
      { path: 'help-support',               element: <HelpSupportPage /> },
      { path: 'security',                   element: <SecurityPage /> },
      { path: 'appearance',                 element: <AppearancePage /> },
      { path: 'swap',                        element: <FeatureGate feature="swap_enabled"><SwapPage /></FeatureGate> },
      { path: 'security/change-passcode',    element: <ChangePasscodePage /> },
      { path: 'backup',                     element: <FeatureGate feature="backup_wallet_enabled"><BackupPage /></FeatureGate> },
      { path: 'edit-profile',               element: <EditProfilePage /> },
      { path: 'notifications',              element: <FeatureGate feature="notifications_enabled"><NotificationsPage /></FeatureGate> },
      { path: 'activity/:id',               element: <TransactionDetailPage /> },
    ],
  },
  { path: '*',                 element: <Navigate to="/" replace /> },
])

export default function App() {
  // Auto-restore the private key on app load / reload.
  // privateKey is never persisted (security), but mnemonic is — so we can
  // re-derive the key silently whenever the wallet is present.
  // NOTE: Auth store persist is async (createJSONStorage wraps localStorage in Promises),
  // so walletAddress/mnemonic may be null on the first render. We subscribe to the
  // auth store and restore as soon as walletAddress becomes available.
  useEffect(() => {
    const tryRestore = (walletAddress: string | null, privateKey: string | null, mnemonic: string | null) => {
      if (walletAddress && !privateKey && mnemonic) {
        import('./lib/restoreWallet').then(({ restorePrivateKey }) => {
          restorePrivateKey().then(ok => {
          }).catch(() => {})
        })
      }
    }

    // Try immediately (works if auth store was already rehydrated synchronously)
    const s = useAuthStore.getState()
    tryRestore(s.walletAddress, s.privateKey, s.mnemonic)

    const unsub = useAuthStore.subscribe((state, prevState) => {
      if (state.walletAddress && !prevState.walletAddress) {
        tryRestore(state.walletAddress, state.privateKey, state.mnemonic)
        unsub()
      }
    })
    return unsub
  }, [])

  // ── Auto-lock when actually offline, revisit through the normal unlock ────
  // screen ─────────────────────────────────────────────────────────────────
  // Previously this only cleared the import-privkey session cache (see
  // lib/security.ts) and left the app sitting wherever it was — coming back
  // online then quietly failed to auto-restore in the background and only
  // surfaced WalletRecoveryBanner's own separate little passcode prompt,
  // which is a second, different-looking "enter your passcode" UI from the
  // one everyone already knows (PasscodeLockPage).
  //
  // Now: going offline locks the whole app instantly, the same isLocked
  // flag (persisted — see lock() in store/index.ts) used everywhere else
  // the app locks. Revisiting after that lands on /auth/lock like any
  // other lock, and PasscodeLockPage's existing handleUnlock() already does
  // exactly what was asked for: the instant the entered passcode verifies,
  // it calls both unlock() AND restorePrivateKey(val) with that SAME
  // passcode (see its last two lines) — one entry, one screen, both the
  // app-unlock and the wallet-key restore. No separate banner/prompt needed.
  useEffect(() => {
    const onOffline = () => {
      const { walletAddress, walletSource, isAuthenticated, passcodeLockEnabled, lock } = useAuthStore.getState()
      if (walletSource === 'import-privkey') {
        import('@/lib/security').then(({ clearSessionPrivateKey }) => clearSessionPrivateKey(walletAddress)).catch(() => {})
      }
      if (isAuthenticated && passcodeLockEnabled) {
        lock()
      }
    }
    window.addEventListener('offline', onOffline)
    return () => window.removeEventListener('offline', onOffline)
  }, [])


  // ── Auto-lock instantly when the browser was actually closed ─────────────
  // The old 15-minute inactivity timer is gone — the app no longer locks
  // just because someone stepped away with the tab open. Instead, this
  // locks instantly the moment a genuinely NEW browser session starts,
  // using a sessionStorage flag as the signal:
  //   - sessionStorage is per-tab and is wiped by the browser the instant
  //     that tab/window is actually closed — it does NOT survive a real
  //     close, so its absence on the next mount means "the browser was
  //     closed since we were last here."
  //   - sessionStorage DOES survive: a manual refresh (F5 / Cmd+R), and
  //     every window.location.reload() the app itself performs — the
  //     stale-deployment-chunk retry in lib/lazyRetry.ts and the
  //     background-suspension recovery reload below both reload the SAME
  //     tab, so the flag is still there and no lock is triggered.
  // Net effect: refreshing or an app update never locks the wallet, but
  // closing the browser (or tab) and reopening it does, immediately —
  // no need to wait out a timer first. `isLocked` is persisted, so once
  // locked, editing the URL can't bypass /auth/lock, and unlocking there
  // always works the normal way regardless of whether an update/reload
  // just happened.
  useEffect(() => {
    const SESSION_FLAG = 'meshport:session-alive'
    const hadSession = sessionStorage.getItem(SESSION_FLAG) === '1'
    sessionStorage.setItem(SESSION_FLAG, '1')

    if (!hadSession) {
      const { isAuthenticated, passcodeLockEnabled, isLocked, lock } = useAuthStore.getState()
      if (isAuthenticated && passcodeLockEnabled && !isLocked) {
        lock()
      }
    }
  }, [])

  // ── Recover from long background suspension ────────────────────────────
  // Mobile browsers/PWAs aggressively suspend backgrounded tabs — timers
  // freeze and, critically, the Supabase Realtime WebSocket connection can
  // get silently killed by the OS without ever firing a 'close' event the
  // app could react to. The result: coming back to the app after a while
  // away can leave it looking "stuck" — no new messages/balance updates
  // arrive, because the app has no idea its realtime connection is dead.
  // If we've been hidden for a while, the safest fix is just a fresh reload
  // (a full page load re-establishes every connection cleanly) rather than
  // trying to detect and selectively repair whichever specific subscription
  // silently died. Short backgrounds (switching apps briefly) don't trigger
  // this — only genuinely long ones, where staleness is likely.
  useEffect(() => {
    let hiddenAt: number | null = null
    const STALE_AFTER_MS = 2 * 60 * 1000 // 2 minutes

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      if (document.visibilityState === 'visible' && hiddenAt) {
        const awayMs = Date.now() - hiddenAt
        hiddenAt = null
        if (awayMs > STALE_AFTER_MS) {
          window.location.reload()
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

  // ── Admin-disabled Biometric Login is enforced globally, not just on the
  // Security settings page — if an admin flips this off while a user already
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
    const addr = useAuthStore.getState().walletAddress
    syncBroadcastNotifications(addr)
    const interval = setInterval(() => syncBroadcastNotifications(useAuthStore.getState().walletAddress), 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') syncBroadcastNotifications(useAuthStore.getState().walletAddress) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [useAuthStore(s => s.user?.id)])

  // ── Push notifications: on by default for every account ───────────────────
  // Notifications should never require a manual "enable" step from the user —
  // every account gets them turned on automatically the moment it's created,
  // imported, or logged into. This subscribes (or re-saves the subscription
  // server-side if one already exists) any time we have a signed-in user.
  useEffect(() => {
    const userId = useAuthStore.getState().user?.id
    if (!userId) return
    import('./lib/pushNotifications').then(({ enablePushNotifications }) => {
      enablePushNotifications(userId).catch(() => {})
    })
  }, [useAuthStore(s => s.user?.id)])

  // ── Wait for Zustand auth store to rehydrate from localStorage ────────────
  // Without this, the router renders immediately with empty state and causes
  // flash of wrong page (login screen on refresh while logged in, or vice versa).
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    // Zustand persist with localStorage is synchronous — rehydration happens
    // before first render but useLayoutEffect fires after. Using a small
    // microtask delay ensures store is populated before we render routes.
    const t = setTimeout(() => setHydrated(true), 0)
    return () => clearTimeout(t)
  }, [])

  // Once hydrated, the real app is about to render — fade out and remove
  // the inline splash from index.html so it doesn't linger on top.
  useEffect(() => {
    if (!hydrated) return
    const splash = document.getElementById('splash')
    if (!splash) return
    splash.classList.add('splash-hide')
    const t = setTimeout(() => splash.remove(), 250)
    return () => clearTimeout(t)
  }, [hydrated])

  // index.html's inline splash (blinking dots) is still visible underneath
  // during this gap, so nothing needs to render here — avoids a double loader.
  if (!hydrated) return null

  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<LoadingDots />}>
        <RouterProvider router={router} />
      </Suspense>
    </QueryClientProvider>
  )
}