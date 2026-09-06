import { Outlet } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { LoginPage, EmailOTPPage, WalletSetupPage, CreateWalletPage, ImportWalletPage } from '@/features/auth/AuthPages'
import { Toast } from '@/components/ui/Toast'

export function AuthGate() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const walletAddress = useAuthStore(s => s.walletAddress)

  // Show toast on all auth screens too
  const withToast = (content: React.ReactNode) => (
    <div className="h-full bg-navy-950 max-w-md mx-auto relative overflow-hidden">
      {content}
      <Toast />
    </div>
  )

  // Not authenticated — show auth flow
  if (!isAuthenticated) {
    return withToast(<LoginPage />)
  }

  // Authenticated but no wallet yet
  if (!walletAddress) {
    return withToast(<WalletSetupPage />)
  }

  // Fully authenticated with wallet — show app
  return <Outlet />
}
