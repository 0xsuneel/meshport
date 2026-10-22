// /insights: approved merchants get their business's insights - on a phone
// that's Business → Reports → Insights (no separate Ledger Insights page),
// on desktop Ledger Insights (their sales and customers). Everyone else
// keeps the personal Insights page.
import { Navigate } from 'react-router-dom'
import { useMerchant } from '@/lib/merchant'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'
import { InsightsPage } from './InsightsPage'
import { LedgerInsightsPage } from './LedgerInsightsPage'

export function InsightsRoute() {
  const { isMerchant } = useMerchant()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  if (!isMerchant) return <InsightsPage />
  return desktop ? <LedgerInsightsPage /> : <Navigate to="/business?screen=reports" replace />
}
