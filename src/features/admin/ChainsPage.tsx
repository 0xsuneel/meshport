import { CategoryTogglePage } from './CategoryTogglePage'

// Multichain Transfer and Multichain Claim each get their own toggle per
// chain (separate app_settings categories: `chains_transfer` / `chains_claim`)
// — disabling a chain for one does not affect the other.
//
// UB / CCTP below are a second, independent layer that only applies to the
// 11 chains that have a working UB (Circle Gateway) path at all — they
// control WHICH bridge mechanism an already-enabled Transfer chain actually
// uses, not whether it's enabled. Default state (UB on, CCTP off) is exactly
// what's hardcoded today, so nothing changes until you flip one — see
// supabase-chains-ub-cctp-override.sql for the full resolution order. Meant
// for exactly this workflow: UB is acting up for a chain → turn CCTP on and
// UB off for just that chain, without needing a code change.
export function ChainsPage() {
  return (
    <CategoryTogglePage
      sections={[
        { title: 'Multichain Transfer', category: 'chains_transfer' },
        { title: 'Multichain Claim',    category: 'chains_claim' },
        { title: 'UB (Circle Gateway)', category: 'chains_ub' },
        { title: 'CCTP Override',       category: 'chains_cctp' },
      ]}
    />
  )
}
