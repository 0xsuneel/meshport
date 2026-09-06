/**
 * mockData.ts — All fake/demo/placeholder data has been removed.
 * MeshPort shows only real user data. Empty states are shown when no data exists.
 */

// These exports are kept for backward compatibility but are all empty
export const mockTransactions = []
export const mockContacts = []
export const mockConversations = []
export const mockChatMessages: Record<string, never[]> = {}
export const mockValidators = []
export const mockRewards = {
  points: 0, level: 'Bronze', nextLevel: 'Silver', pointsToNext: 1000,
  totalEarned: 0, totalCashback: 0, campaigns: [], recentActivity: [],
}
export const mockTreasury = {
  totalStaked: 0, pendingRewards: 0, apr: 0, validators: [],
}
export const mockNotifications = []
