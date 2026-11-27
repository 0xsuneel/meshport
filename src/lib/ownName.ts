import { useAuthStore } from '@/store'
import { getRegisteredBusinessName } from './orderLabels'

/** How the signed-in account is named on its own receipts - like Paytm's
 *  "From Sunil Vittal Rathod", never "You": a business by its registered
 *  name, a person by their display name, else their MeshPort username. */
export function ownAccountName(): string {
  const u = useAuthStore.getState().user
  return getRegisteredBusinessName()
    || u?.displayName?.trim()
    || (u?.username ? `${String(u.username).replace(/\.arc$/i, '')}.arc` : '')
    || 'My wallet'
}
