import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import {
  Search, Send, UserPlus, CheckCircle, MessageCircle,
  Loader2, Users, X, ChevronRight, Trash2, AlertTriangle,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Avatar } from '@/components/ui/Avatar'
import { Input } from '@/components/ui/Input'
import { Sheet } from '@/components/ui/Sheet'
import { useAuthStore, useUIStore, useWalletStore } from '@/store'
import { notifyRewardSend } from '@/lib/notifications'
import {} from '@/components/ui/UsernameDisplay'
import { formatAmount } from '@/lib/utils'
import type { Transaction } from '@/types'
import {
  searchUsersDb, addContactDb, fetchContactsDb,
  getOrCreateConversation, sendMessage as dbSendMessage, type DbUser,
} from '@/lib/supabase'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

type LocalContact = DbUser & { isFavorite?: boolean }

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')

export function ContactsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user          = useAuthStore(s => s.user)
  const privateKey    = useAuthStore(s => s.privateKey)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const { showToastMessage } = useUIStore()
  const { balance, setBalance } = useWalletStore()

  const [contacts, setContacts] = useState<LocalContact[]>([])
  const [loading, setLoading] = useState(false)  // false until first fetch
  const [search, setSearch] = useState('')

  // Add sheet
  const [showAdd, setShowAdd] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState<DbUser[]>([])
  const [addLoading, setAddLoading] = useState(false)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState<string | null>(null)

  // Action popup
  const [selected, setSelected] = useState<LocalContact | null>(null)

  // Payment modal
  const [payStep, setPayStep] = useState<'closed' | 'form' | 'confirm' | 'processing' | 'success'>('closed')
  const [payTarget, setPayTarget] = useState<LocalContact | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [showAmountPad, setShowAmountPad] = useState(false)
  const [payNote, setPayNote] = useState('')
  const [payError, setPayError] = useState('')
  const [payTxHash, setPayTxHash] = useState('')
  const [payPassEntry, setPayPassEntry] = useState('')
  const NETWORK_FEE = 0.001

  const getUserId = useCallback(() => {
    if (!user?.id) return null
    return user.id
  }, [user?.id])

  // ── Load contacts — only once per session, not on every re-render ─────────
  const userId = user?.id ?? null
  const loadedForRef = { current: '' }  // track which userId we loaded for
  useEffect(() => {
    if (!userId) return
    if (loadedForRef.current === userId && contacts.length > 0) return  // already loaded
    loadedForRef.current = userId
    setLoading(contacts.length === 0)
    fetchContactsDb(userId).then(rows => {
      // Self-transfer: always include your own profile in the Contacts list,
      // synthetic (never written to user_contacts) — same reasoning as the
      // pinned entry in PaySendPage's recipient picker. Sorts normally into the
      // A–Z grouping below; the "(You)" tag at render time is what makes it
      // identifiable, not special placement.
      const already = rows.some(r => r.id === userId)
      const self: LocalContact | null = (!already && user)
        ? {
            id: user.id,
            username: user.username,
            display_name: user.displayName || user.username,
            email: user.email,
            wallet_address: walletAddress || user.walletAddress,
            avatar_url: user.avatar || null,
            created_at: user.createdAt,
          }
        : null
      setContacts(self ? [...rows, self] : rows)
      setLoading(false)
    }).catch(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])  // only re-run when user actually changes

  // ── Search to add — exact .arc match only ──────────────────────────────────
  useEffect(() => {
    const q = addQuery.trim()
    if (!q) { setAddResults([]); return }
    // Only search when full .arc suffix is present
    if (!q.toLowerCase().endsWith('.arc')) { setAddResults([]); return }
    setAddLoading(true)
    const timer = setTimeout(() => {
      // No excludeUserId — self-transfer is permitted, and finding your own
      // username here is expected (you're already shown as a pinned "(You)"
      // contact regardless, this just lets the same search box find you too
      // rather than silently returning nothing for your own handle).
      searchUsersDb(q).then(results => {
        const existingIds = new Set(contacts.map(c => c.id))
        setAddResults(results.filter(u => !existingIds.has(u.id)))
        setAddLoading(false)
      }).catch(() => setAddLoading(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [addQuery, contacts, userId])

  const handleAdd = async (contactUser: DbUser) => {
    const uid = getUserId()
    if (!uid) { showToastMessage('Please complete your profile first', 'error'); return }
    setAddingId(contactUser.id)
    const { error } = await addContactDb(uid, contactUser.id)
    setAddingId(null)
    if (error) { showToastMessage('Could not add contact: ' + error, 'error'); return }
    setContacts(prev => prev.find(c => c.id === contactUser.id) ? prev : [...prev, contactUser])
    const cleanName = (contactUser.username || '').replace(/\.arc$/, '')
    setJustAdded(cleanName + '.arc')
    setTimeout(() => setJustAdded(null), 3000)
    setShowAdd(false); setAddQuery(''); setAddResults([])
    showToastMessage(cleanName + '.arc added!', 'success')
  }

  // ── Open chat ──────────────────────────────────────────────────────────────
  const handleChat = async (c: LocalContact) => {
    const uid = getUserId()
    if (!uid) return
    setSelected(null)
    const { id: convId, error } = await getOrCreateConversation(uid, c.id)
    if (error || !convId) { showToastMessage('Could not open chat', 'error'); return }
    // Warm the chat header cache with this contact's already-known data
    // (avatar/name/username) before navigating — same reasoning as the
    // equivalent fix in HomePage.tsx's openChatWithUser. Without this,
    // opening a chat from Contacts (rather than the Chats list itself) had
    // nothing cached yet and the header still visibly popped in late.
    const { cacheOtherUser } = await import('@/features/chat/ChatPage')
    cacheOtherUser(convId, c)
    navigate(`/chat/${convId}`)
  }

  // ── Remove contact state ───────────────────────────────────────────────────
  const [confirmRemove, setConfirmRemove] = useState<LocalContact | null>(null)

  const handleRemoveContact = async (c: LocalContact) => {
    const uid = getUserId()
    if (!uid) return
    // Add to removed blocklist so they don't appear in recents/contacts
    const { addRemovedContact } = await import('@/lib/removedContacts')
    addRemovedContact(walletAddress, c.id)
    // Remove from local state immediately
    setContacts(prev => prev.filter(x => x.id !== c.id))
    setConfirmRemove(null)
    setSelected(null)
    // Remove from Supabase contacts table — column names must be owner_id
    // (matching every read/write elsewhere in supabase.ts). This was
    // previously querying user_id, a column that doesn't match what's
    // actually written, meaning the real DB row was very likely never
    // deleted — only the client-side blocklist made removal look like it
    // worked, on this device only.
    try {
      const { supabase } = await import('@/lib/supabase')
      await supabase.from('contacts')
        .delete()
        .or(`and(owner_id.eq.${uid},contact_id.eq.${c.id}),and(owner_id.eq.${c.id},contact_id.eq.${uid})`)
    } catch (e) { console.warn('[Contacts] Remove contact DB:', e) }
    // Also hide their existing chat conversation, if one exists — removing
    // a contact should mean they disappear from Chats too, not just from
    // Contacts/Recent. It automatically reappears the moment they message
    // or pay again, via the existing unhideChat-on-new-message logic.
    try {
      const { supabase } = await import('@/lib/supabase')
      const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .or(`and(participant_a.eq.${uid},participant_b.eq.${c.id}),and(participant_a.eq.${c.id},participant_b.eq.${uid})`)
        .maybeSingle()
      if (conv?.id) {
        const key = walletAddress ? `meshport_hidden_chats_${walletAddress.toLowerCase()}` : 'meshport_hidden_chats_anon'
        const hidden = new Set(JSON.parse(localStorage.getItem(key) || '[]'))
        hidden.add(conv.id)
        localStorage.setItem(key, JSON.stringify([...hidden]))
      }
    } catch (e) { console.warn('[Contacts] Hide chat on remove:', e) }
    showToastMessage((c.display_name || (c.username || '').replace(/\.arc$/, '')) + ' removed from contacts', 'info')
  }

  // ── Open payment modal (in-page, no redirect) ──────────────────────────────
  const openPay = (c: LocalContact) => {
    if (!c.wallet_address) { showToastMessage('Recipient wallet not available', 'error'); return }
    setPayTarget(c)
    setPayAmount(''); setPayNote(''); setPayError(''); setPayTxHash(''); setPayPassEntry('')
    setSelected(null)
    setPayStep('form')
  }

  // ── Execute payment ────────────────────────────────────────────────────────
  const executePayment = async () => {
    const numAmount = parseFloat(payAmount)
    const c = payTarget
    if (!numAmount || numAmount <= 0) { setPayError('Enter a valid amount'); setPayStep('form'); return }
    if (!c?.wallet_address) { setPayError('Recipient wallet not available'); setPayStep('form'); return }

    setPayError(''); setPayStep('processing')

    let activePrivateKey = privateKey
    if (!activePrivateKey) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(payPassEntry || undefined)
        activePrivateKey = useAuthStore.getState().privateKey
      } catch {}
    }
    if (!activePrivateKey) {
      setPayError("Couldn't access your wallet on this device. Sign out and re-import your wallet with your recovery phrase or private key to continue.")
      setPayStep('confirm')
      return
    }

    try {
      const { sendUSDC, getUSDCBalance } = await import('@/lib/arcService')
      const result = await sendUSDC({ privateKey: activePrivateKey, to: c.wallet_address, amount: numAmount })
      setPayTxHash(result.txHash)

      // Record in activity feed
      if (result.txHash) {
        import('@/lib/ActivityService').then(({ Activity }) => {
          const { walletAddress: wa } = useAuthStore.getState()
          if (wa) Activity.send({
            walletAddress: wa, txHash: result.txHash, amount: numAmount,
            tokenSymbol: 'USDC', toAddress: result.recipientAddress || c.wallet_address,
            toUsername: c.username || undefined,
          }).catch(() => {})
        }).catch(() => {})
      }

      const recipientClean = (c.username || '').replace(/\.arc$/, '')
          // Transaction on-chain — ArcScan is source of truth

      // Award points (best effort)
      try {
        const { awardTransactionPoints } = await import('@/lib/rewards')
        const { user: u, walletAddress: wa } = useAuthStore.getState()
        const pointUserId = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? `wallet_${wa.toLowerCase().slice(2, 18)}` : null
        if (pointUserId && wa) {
          const r = await awardTransactionPoints({ userId: pointUserId, walletAddress: wa, txHash: result.txHash })
          if (r.pointsAwarded > 0) notifyRewardSend(r.pointsAwarded)
        }
      } catch {}

      // Drop a payment_sent message into the conversation so it shows in chat too
      try {
        const uid = getUserId()
        if (uid) {
          const { id: convId } = await getOrCreateConversation(uid, c.id)
          if (convId) {
            await dbSendMessage({
              conversationId: convId, senderId: uid,
              content: `Sent ${formatAmount(numAmount)} USDC to ${recipientClean}.arc`,
              type: 'payment_sent', paymentAmount: numAmount, paymentTxHash: result.txHash,
            })
          }
        }
      } catch {}

      // Refresh balance
      try {
        const { deriveAddressFromPrivateKey } = await import('@/lib/arc')
        const realAddr = await deriveAddressFromPrivateKey(activePrivateKey)
        getUSDCBalance(realAddr).then(bal => setBalance(bal))
      } catch {}

      setPayStep('success')
      setTimeout(() => { setPayStep('closed'); setPayTarget(null) }, 2200)
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || 'Payment failed'
      setPayError(msg)
      setPayStep('form')
    }
  }

  // ── Filter + alphabetical grouping ─────────────────────────────────────────
  const filtered = contacts.filter(c => {
    const q = search.toLowerCase()
    return (c.username || '').toLowerCase().includes(q)
      || (c.display_name || '').toLowerCase().includes(q)
      || (c.wallet_address || '').toLowerCase().includes(q)
  })

  const grouped = filtered
    .slice()
    .sort((a, b) => (a.display_name || a.username || '').localeCompare(b.display_name || b.username || ''))
    .reduce<Record<string, LocalContact[]>>((acc, c) => {
      const letter = (c.display_name || c.username || '#').charAt(0).toUpperCase()
      const key = /[A-Z]/.test(letter) ? letter : '#'
      ;(acc[key] = acc[key] || []).push(c)
      return acc
    }, {})
  const letters = Object.keys(grouped).sort()

  return (
    <div className="flex-1 overflow-y-auto bg-bg lg:max-w-[900px]">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-bg/95 backdrop-blur-md px-5 pt-header pb-3">
        <div className="header-row justify-between mb-4">
          <h1 className="text-xl font-bold text-text-primary">Contacts</h1>
          <motion.button whileTap={{ scale: 0.9 }} onClick={() => setShowAdd(true)}
            className="w-11 h-11 rounded-full bg-brand flex items-center justify-center">
            <UserPlus className="w-5 h-5 text-white" />
          </motion.button>
        </div>
        <div className="flex items-center gap-2.5 bg-surface border border-border rounded-2xl px-4 py-3">
          <Search className="w-4 h-4 text-text-secondary flex-shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by username or name"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-secondary focus:outline-none" />
        </div>
      </div>

      {/* Added notification */}
      <AnimatePresence>
        {justAdded && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mx-4 mb-2 p-3 bg-success/10 border border-success/30 rounded-2xl flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-success" />
            <p className="text-sm text-success font-medium">{justAdded} added to contacts</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      <div className="px-4 pb-6 relative">
        {loading && contacts.length === 0 ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-brand animate-spin" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-4">
              <Users className="w-8 h-8 text-text-muted" />
            </div>
            <p className="text-text-secondary font-medium text-lg">
              {search ? `No contacts match "${search}"` : 'No Contacts Yet'}
            </p>
            <p className="text-text-muted text-sm mt-1">Tap Add Contact to find MeshPort users</p>
            {!search && (
              <button onClick={() => setShowAdd(true)}
                className="mt-4 px-5 py-2.5 bg-brand text-white text-sm font-semibold rounded-2xl"
                style={{ border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                Add Your First Contact
              </button>
            )}
          </div>
        ) : (
          <>
          <div className="space-y-4 pr-1">
            {letters.map(letter => (
              <div key={letter} id={`section-${letter}`}>
                <p className="px-2 pb-1.5 text-sm font-bold text-brand">{letter}</p>
                <div className="bg-surface rounded-3xl overflow-hidden divide-y divide-border border border-border" style={{boxShadow:"var(--shadow-1)"}}>
                  {grouped[letter].map(c => {
                    const clean = (c.username || '').replace(/\.arc$/, '')
                    const isSelf = c.id === userId
                    return (
                      <motion.button key={c.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setSelected(c)}
                        className="flex items-center gap-3 px-4 py-4 w-full text-left hover:bg-brand/[0.07] active:bg-brand/10 transition-all duration-150">
                        <Avatar name={c.display_name} src={c.avatar_url ? c.avatar_url.split('?')[0] : undefined} size="lg" className="flex-shrink-0 !w-[57px] !h-[57px]" />
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-bold text-text-primary truncate flex items-center gap-1.5">
                            {c.display_name || clean}{isSelf ? ' (You)' : ''}
                            
                          </p>
                          <p className="text-sm text-link truncate">{clean}.arc</p>
                        </div>
{/* No chevron */}
                      </motion.button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* A–Z side index */}
          <div className="absolute top-0 right-0 bottom-0 w-5 flex flex-col items-center justify-start pt-1 gap-0.5 select-none">
            {ALPHABET.map(L => {
              const active = letters.includes(L)
              return (
                <button key={L} disabled={!active}
                  onClick={() => {
                    const el = document.getElementById(`section-${L}`)
                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  className={`text-[10px] leading-none font-semibold ${active ? 'text-brand' : 'text-text-muted'}`}>
                  {L}
                </button>
              )
            })}
          </div>
          </>
        )}
      </div>

      {/* ── Add Contact Sheet ── */}
      <Sheet isOpen={showAdd} onClose={() => { setShowAdd(false); setAddQuery(''); setAddResults([]) }} title="Add Contact">
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-text-secondary">Search by username or name to find MeshPort users</p>
          <Input placeholder="username.arc (exact match)" value={addQuery}
            onChange={e => setAddQuery(e.target.value)} autoFocus
            leftIcon={addLoading ? <Loader2 className="w-4 h-4 animate-spin text-brand" /> : <Search className="w-4 h-4" />} />
          {!addQuery.trim().toLowerCase().endsWith('.arc') && addQuery.trim() ? (
            <p className="text-center text-text-secondary text-xs py-2">
              Enter full username (example: sunil.arc)
            </p>
          ) : addResults.length > 0 ? (
            <div className="bg-surface rounded-2xl border border-border divide-y divide-border">
              {addResults.map(u => (
                <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar name={u.display_name} src={u.avatar_url} size="md" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-text-primary truncate flex items-center gap-1.5">
                      {u.display_name || (u.username || '').replace(/\.arc$/, '')}
                      
                    </p>
                    <p className="text-xs text-link">{(u.username || '').replace(/\.arc$/, '')}.arc</p>
                  </div>
                  <button onClick={() => handleAdd(u)} disabled={addingId === u.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-brand/20 text-brand border border-brand/30 rounded-xl text-xs font-semibold active:scale-90 transition-transform disabled:opacity-50">
                    {addingId === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                    {addingId === u.id ? '...' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          ) : addQuery.trim() && !addLoading ? (
            <div className="text-center py-8">
              <p className="text-text-secondary text-sm">No users found for "<span className="text-text-primary">{addQuery}</span>"</p>
              <p className="text-text-muted text-xs mt-1">They must be registered on MeshPort</p>
            </div>
          ) : !addQuery.trim() ? (
            <p className="text-center text-text-muted text-sm py-4">Start typing to search</p>
          ) : null}
        </div>
      </Sheet>

      {/* ── Contact Action Popup ── */}
      <AnimatePresence>
        {selected && (() => {
          const selectedContent = (
            <>
              <div className="flex flex-col items-center text-center mb-5">
                <Avatar name={selected.display_name} src={selected.avatar_url} size="xl" className="mb-3" showRing />
                <p className="text-2xl font-bold text-text-primary">
                  {selected.display_name || (selected.username || '').replace(/\.arc$/, '')}{selected.id === userId ? ' (You)' : ''}
                </p>
                <p className="text-base text-link mt-0.5">{(selected.username || '').replace(/\.arc$/, '')}.arc</p>
                <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-full">
                  <span className="text-sm text-text-primary font-medium">Verified User</span>
                </div>
              </div>
              <div className="space-y-2.5">
                <button onClick={() => openPay(selected)}
                  className="w-full flex items-center gap-3 px-5 py-4 bg-brand rounded-2xl text-white font-semibold active:scale-95 transition-transform"
                  style={{ border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                  <Send className="w-5 h-5" />
                  Pay
                </button>
                <button onClick={() => handleChat(selected)}
                  className="w-full flex items-center gap-3 px-5 py-4 bg-surface rounded-2xl text-text-primary font-semibold active:scale-95 transition-transform">
                  <MessageCircle className="w-5 h-5 text-text-secondary" />
                  Message
                </button>
                {selected.id !== userId && (
                  <button onClick={() => { setConfirmRemove(selected); setSelected(null) }}
                    className="w-full flex items-center gap-3 px-5 py-4 bg-danger/10 border border-danger/20 rounded-2xl text-danger font-semibold active:scale-95 transition-transform">
                    <Trash2 className="w-5 h-5" />
                    Remove Contact
                  </button>
                )}
                <button onClick={() => setSelected(null)}
                  className="w-full px-5 py-4 bg-surface/60 rounded-2xl text-text-secondary font-semibold active:scale-95 transition-transform">
                  Cancel
                </button>
              </div>
            </>
          )
          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setSelected(null)} maxWidth={400}>
              <div className="px-5 pt-6 pb-6">{selectedContent}</div>
            </DesktopDialogFrame>
          ) : (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setSelected(null)} />
              <motion.div
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                className="absolute bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-3xl px-5 pt-5 pb-8">
                {selectedContent}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      {/* ── Remove Contact Confirmation ── */}
      <AnimatePresence>
        {confirmRemove && (() => {
          const removeContent = (
            <>
              <div className="flex flex-col items-center text-center mb-6">
                <div className="w-14 h-14 rounded-full bg-danger/15 flex items-center justify-center mb-3">
                  <AlertTriangle className="w-7 h-7 text-danger" />
                </div>
                <h2 className="text-xl font-bold text-text-primary">Remove Contact</h2>
                <p className="text-sm text-text-secondary mt-2">
                  Are you sure you want to remove{' '}
                  <span className="text-text-primary font-semibold">
                    {confirmRemove.display_name || (confirmRemove.username || '').replace(/\.arc$/, '')}
                  </span>{' '}
                  from your contacts?
                </p>
                <p className="text-xs text-text-muted mt-2">Chat history and payment records will be preserved.</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setConfirmRemove(null)}
                  className="flex-1 py-4 rounded-2xl text-sm font-bold bg-surface text-text-secondary active:scale-95 transition-transform">
                  Cancel
                </button>
                <button onClick={() => handleRemoveContact(confirmRemove)}
                  className="flex-1 py-4 rounded-2xl text-sm font-bold bg-danger/20 border border-danger/30 text-danger active:scale-95 transition-transform">
                  Confirm
                </button>
              </div>
            </>
          )
          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setConfirmRemove(null)} maxWidth={400}>
              <div className="px-5 pt-7 pb-7">{removeContent}</div>
            </DesktopDialogFrame>
          ) : (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setConfirmRemove(null)} />
              <motion.div
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                className="absolute bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-3xl px-5 pt-6 pb-10">
                {removeContent}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      {/* ── In-Page Payment Modal ── */}
      <AnimatePresence>
        {payStep !== 'closed' && payTarget && (() => {
          const closePay = () => { if (payStep === 'form' || payStep === 'confirm') { setPayStep('closed'); setPayTarget(null) } }
          const payContent = (
            <>
              {payStep === 'form' && (
                <div className="px-5 pt-4 pb-8 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-text-primary">Pay</h2>
                    <button onClick={() => { setPayStep('closed'); setPayTarget(null) }} className="p-2 rounded-full hover:bg-text-primary/10 text-text-secondary"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-surface rounded-2xl border border-border">
                    <Avatar name={payTarget.display_name} src={payTarget.avatar_url} size="sm" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
                        {payTarget.display_name || (payTarget.username || '').replace(/\.arc$/, '')}
                        
                      </p>
                      <p className="text-xs text-link">{(payTarget.username || '').replace(/\.arc$/, '')}.arc</p>
                    </div>
                  </div>
                  <div>
                    <div style={{background:'var(--surface)', borderRadius:'1.5rem', border:'1px solid var(--border)', padding:'16px'}}>
                      {/* Amount display — tap to expand keypad. Mobile only;
                          desktop's live amount input is the always-open
                          AmountKeypad card right below instead. */}
                      {!isDesktop && (
                        <div onClick={() => setShowAmountPad(v => !v)} style={{textAlign:'center', cursor:'pointer', paddingBottom: showAmountPad ? 12 : 0}}>
                          <div style={{display:'flex', alignItems:'baseline', justifyContent:'center', gap:4}}>
                            <span style={{fontSize:44, fontWeight:700, lineHeight:1, color: payAmount ? 'var(--text-primary)' : 'color-mix(in srgb, var(--text-primary) 20%, transparent)'}}>$</span>
                            <span style={{fontSize: payAmount && payAmount.length > 5 ? 36 : 44, fontWeight:700, color:'var(--text-primary)', fontFamily:'monospace', lineHeight:1}}>{payAmount || '0'}</span>
                          </div>
                          <p style={{fontSize:13, color:'var(--text-muted)', marginTop:4}}>USDC · Balance: {formatAmount(balance)} — {showAmountPad ? 'typing...' : 'tap to enter'}</p>
                        </div>
                      )}

                      {/* Inline keypad */}
                    <AmountKeypad
                      open={isDesktop || showAmountPad}
                      value={payAmount}
                      onChange={v => { setPayAmount(v); setPayError('') }}
                      balance={balance}
                      token="USDC"
                      quickAmounts={[10, 20, 50, 100]}
                      onClose={() => setShowAmountPad(false)}
                      onDone={isDesktop ? undefined : () => setShowAmountPad(false)}
                    />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary mb-1.5 block">Note (Optional)</label>
                    <input value={payNote} onChange={e => setPayNote(e.target.value)}
                      placeholder="What's this for?"
                      className="w-full bg-surface border border-border rounded-2xl px-4 py-3 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-brand" />
                  </div>
                  {payError && (
                    <div className="p-3 bg-danger/10 border border-danger/30 rounded-2xl"><p className="text-sm text-danger">{payError}</p></div>
                  )}
                  <div className="flex gap-3">
                    <button onClick={() => { setPayStep('closed'); setPayTarget(null) }}
                      className="flex-1 py-3.5 rounded-2xl text-sm font-bold bg-surface text-text-secondary active:scale-95 transition-transform">Cancel</button>
                    <button onClick={() => { const n = parseFloat(payAmount); if (!n || n <= 0) { setPayError('Enter a valid amount'); return } setPayStep('confirm') }}
                      disabled={!payAmount || parseFloat(payAmount) <= 0}
                      className="flex-1 py-3.5 rounded-2xl text-sm font-bold text-white disabled:opacity-40 active:scale-95 transition-transform" style={{background:"var(--brand)", border: '1px solid color-mix(in srgb, black 12%, transparent)'}}>Continue</button>
                  </div>
                </div>
              )}

              {payStep === 'confirm' && (
                <div className="px-5 pt-4 pb-8 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-text-primary">Review Payment</h2>
                    <button onClick={() => setPayStep('form')} className="p-2 rounded-full hover:bg-text-primary/10 text-text-secondary"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="bg-surface rounded-2xl border border-border divide-y divide-border">
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm text-text-secondary">Recipient</span>
                      <span className="text-sm font-semibold text-link">{(payTarget.username || '').replace(/\.arc$/, '')}.arc</span>
                    </div>
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm text-text-secondary">Amount</span>
                      <span className="text-sm font-bold text-text-primary">{formatAmount(parseFloat(payAmount) || 0)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm text-text-secondary">Network Fee</span>
                      <span className="text-sm text-text-primary">{NETWORK_FEE} USDC</span>
                    </div>
                    {payNote && (
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-text-secondary">Note</span>
                        <span className="text-sm text-text-primary truncate max-w-[60%]">{payNote}</span>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-text-secondary text-center">Enter passcode to confirm</p>
                    <PinKeypad
                      value={payPassEntry}
                      onChange={v => setPayPassEntry(v)}
                      length={6}
                      error={!!payError}
                      onComplete={() => executePayment()}
                    />
                    {payError && <p className="text-xs text-danger text-center">{payError}</p>}
                  </div>
                </div>
              )}

              {payStep === 'processing' && (
                <div className="px-5 pt-10 pb-12 flex flex-col items-center gap-4">
                  <Loader2 className="w-12 h-12 text-brand animate-spin" />
                  <p className="text-text-primary font-semibold">Sending payment...</p>
                  <p className="text-sm text-text-secondary">Confirming on Arc network</p>
                </div>
              )}

              {payStep === 'success' && (
                <div className="px-5 pt-10 pb-12 flex flex-col items-center gap-3">
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', damping: 12 }}
                    className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center">
                    <CheckCircle className="w-9 h-9 text-success" />
                  </motion.div>
                  <p className="text-lg font-bold text-text-primary">Payment Sent</p>
                  <p className="text-sm text-text-secondary">{formatAmount(parseFloat(payAmount) || 0)} USDC sent to {(payTarget.username || '').replace(/\.arc$/, '')}.arc</p>
                  {payTxHash && (
                    <a href={`https://testnet.arcscan.app/tx/${payTxHash}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-brand">View on ArcScan →</a>
                  )}
                </div>
              )}
            </>
          )
          return isDesktop ? (
            <DesktopDialogFrame onClose={closePay} maxWidth={440}>
              <div className="max-h-[80vh] overflow-y-auto">{payContent}</div>
            </DesktopDialogFrame>
          ) : (
            <>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40"
                onClick={closePay} />
              <motion.div
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                className="absolute bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-3xl max-h-[85vh] overflow-y-auto">
                {payContent}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>
    </div>
  )
}
