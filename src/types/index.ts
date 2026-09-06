// User & Auth
export interface User {
  id: string
  username: string
  displayName: string
  email: string
  avatar: string | null
  walletAddress: string
  country: string
  createdAt: string
}

export interface AuthState {
  user: User | null
  isAuthenticated: boolean
  token: string | null
}

// Transactions
// 'bridge' kept for backward-compat with old persisted records — treat as 'multichain'
export type TransactionType = 'sent' | 'received' | 'treasury' | 'rewards' | 'bulk_payout' | 'multichain' | 'bridge' | 'merchant'
export type TransactionStatus = 'completed' | 'pending' | 'failed'

export interface Transaction {
  id: string
  type: TransactionType
  status: TransactionStatus
  amount: number
  usdValue: number
  from: string
  fromUsername: string | null
  fromAvatar: string | null
  to: string
  toUsername: string | null
  toAvatar: string | null
  note: string | null
  txHash: string
  timestamp: string
  fee: number
  // Multichain / bridge fields
  bridgeSourceChain?: string
  bridgeDestChain?: string
  bridgeFee?: number
  bridgeNetworkFee?: number
  bridgeReceiverGets?: number
  // Bulk payout fields
  bulkRecipientCount?: number
}

// Contacts
export interface Contact {
  id: string
  username: string
  displayName: string
  walletAddress: string
  avatar: string | null
  isFavorite: boolean
  lastTransaction: string | null
}

// Treasury / Validators
export interface Validator {
  id: string
  name: string
  apy: number
  tvl: number
  uptime: number
  status: 'active' | 'inactive' | 'jailed'
  myStake: number
  pendingRewards: number
  logo: string | null
}

export interface TreasuryState {
  balance: number
  totalValue: number
  totalYieldEarned: number
  activeValidators: number
  dailyYield: number
  monthlyYield: number
  lifetimeYield: number
  currentApy: number
}
