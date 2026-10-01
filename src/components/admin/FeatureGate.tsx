import { Navigate } from 'react-router-dom'
import { useSettingsStore } from '@/store/settingsStore'

interface FeatureGateProps {
  feature: string
  children: React.ReactNode
  fallback?: string
}

/**
 * Hides a route from regular users when the admin has disabled the backing
 * feature flag. Defaults to "enabled" until settings have loaded so a slow
 * network never blocks legitimate access.
 */
export function FeatureGate({ feature, children, fallback = '/' }: FeatureGateProps) {
  const { settings, loaded } = useSettingsStore()
  const row = settings[feature]
  if (loaded && row && row.enabled === false) {
    return <Navigate to={fallback} replace />
  }
  return <>{children}</>
}
