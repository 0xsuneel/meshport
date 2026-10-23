// /insights: approved merchants get their business's insights - on a phone
// that's Business → Reports → Insights (no separate Business Insights page),
// on desktop Business Insights (their sales and customers). Everyone else
// keeps the personal Insights page.
import { Navigate } from 'react-router-dom'
import { useMerchant } from '@/lib/merchant'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'
import { InsightsPage } from './InsightsPage'
import { BusinessInsightsPage } from './BusinessInsightsPage'

export function InsightsRoute() {
  const { isMerchant } = useMerchant()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  if (!isMerchant) return <InsightsPage />
  return desktop ? <BusinessInsightsPage /> : <Navigate to="/business?screen=reports" replace />
}
