// /insights: approved merchants get Ledger Insights (their sales and
// customers); everyone else keeps the personal Insights page.
import { useMerchant } from '@/lib/merchant'
import { InsightsPage } from './InsightsPage'
import { LedgerInsightsPage } from './LedgerInsightsPage'

export function InsightsRoute() {
  const { isMerchant } = useMerchant()
  return isMerchant ? <LedgerInsightsPage /> : <InsightsPage />
}
