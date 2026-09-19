import { CategoryTogglePage } from './CategoryTogglePage'

export function FeaturesPage() {
  return (
    <CategoryTogglePage
      sections={[
        { title: 'Payments',  category: 'payments' },
        { title: 'Wallet',    category: 'wallet' },
        { title: 'Security',  category: 'security' },
        { title: 'Swap',      category: 'swap' },
        { title: 'Multichain', category: 'multichain' },
        { title: 'Rewards',   category: 'rewards' },
        { title: 'Social',    category: 'social' },
        { title: 'Username',  category: 'username' },
      ]}
    />
  )
}
