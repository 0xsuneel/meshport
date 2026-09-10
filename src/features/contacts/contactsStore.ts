/**
 * ContactsStore — lightweight local cache only.
 * Source of truth is Supabase (loaded in ContactsPage).
 * Storage key is wallet-scoped to prevent contact leakage between wallets.
 */
import { create } from 'zustand'
import { useAuthStore } from '@/store'
import type { Contact } from '@/types'

interface ContactsStore {
  contacts: Contact[]
  setContacts:  (contacts: Contact[]) => void
  addContact:   (contact: Contact) => void
  removeContact:(id: string) => void
  clearContacts:() => void
}

function contactsKey(addr: string | null) {
  return addr ? `meshport-contacts-v3-${addr.toLowerCase()}` : null
}
function saveContacts(addr: string | null, contacts: Contact[]) {
  const k = contactsKey(addr)
  if (!k) return
  try { localStorage.setItem(k, JSON.stringify(contacts)) } catch {}
}
function loadContacts(addr: string | null): Contact[] {
  const k = contactsKey(addr)
  if (!k) return []
  try {
    const raw = localStorage.getItem(k)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export const useContactsStore = create<ContactsStore>()((set, get) => ({
  contacts: loadContacts(useAuthStore.getState().walletAddress),

  setContacts: (contacts) => {
    saveContacts(useAuthStore.getState().walletAddress, contacts)
    set({ contacts })
  },
  addContact: (contact) =>
    set((state) => {
      if (state.contacts.find(c => c.id === contact.id)) return state
      const contacts = [...state.contacts, contact]
      saveContacts(useAuthStore.getState().walletAddress, contacts)
      return { contacts }
    }),
  removeContact: (id) =>
    set((state) => {
      const contacts = state.contacts.filter(c => c.id !== id)
      saveContacts(useAuthStore.getState().walletAddress, contacts)
      return { contacts }
    }),
  clearContacts: () => {
    saveContacts(useAuthStore.getState().walletAddress, [])
    set({ contacts: [] })
  },
}))

// Re-load contacts whenever wallet switches
useAuthStore.subscribe((state, prevState) => {
  if (state.walletAddress !== prevState.walletAddress) {
    const contacts = loadContacts(state.walletAddress)
    useContactsStore.setState({ contacts })
  }
})
