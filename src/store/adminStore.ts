import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AdminStore {
  isAdminAuthenticated: boolean
  adminEmail: string | null
  setAdminSession: (email: string) => void
  clearAdminSession: () => void
}

export const useAdminStore = create<AdminStore>()(
  persist(
    (set) => ({
      isAdminAuthenticated: false,
      adminEmail: null,
      setAdminSession: (email) => set({ isAdminAuthenticated: true, adminEmail: email }),
      clearAdminSession: () => set({ isAdminAuthenticated: false, adminEmail: null }),
    }),
    { name: 'meshport-admin-session' },
  ),
)
