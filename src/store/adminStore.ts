import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AdminStore {
  isAdminAuthenticated: boolean
  adminEmail: string | null
  adminRole: 'owner' | 'operations' | 'support' | 'viewer' | null
  setAdminSession: (email: string) => void
  setAdminRole: (role: AdminStore['adminRole']) => void
  clearAdminSession: () => void
}

export const useAdminStore = create<AdminStore>()(
  persist(
    (set) => ({
      isAdminAuthenticated: false,
      adminEmail: null,
      adminRole: null,
      setAdminSession: (email) => set({ isAdminAuthenticated: true, adminEmail: email }),
      setAdminRole: (adminRole) => set({ adminRole }),
      clearAdminSession: () => set({ isAdminAuthenticated: false, adminEmail: null, adminRole: null }),
    }),
    { name: 'meshport-admin-session' },
  ),
)
