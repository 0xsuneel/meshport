import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useId, memo, Fragment, type ReactNode } from 'react'
import { SHEET_SPRING, SHEET_BACKDROP, DIALOG_CARD, SNACKBAR_MOTION, DIALOG_BACKDROP } from '@/lib/motion'
import { useHideOnScroll, collapseStyle } from '@/hooks/useHideOnScroll'
import { _plainByContent, plainTextOf, messagePreview, parseMedia, isDecryptFailure, splitCaption } from './chatMessageText'
import { ChatForwardSheet } from './ChatForwardSheet'
import { ChatImage, ChatFile, QuoteThumb, FileTypeTile, MediaPreview, ChatImageViewer, type PreviewItem, type ViewerItem } from './ChatMedia'
import { preparePhoto, uploadWithProgress, withMeta, metaOf, putCachedMedia, mimeOf } from './chatMedia'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { Search, Send, ArrowLeft, CheckCheck, Paperclip, Image, FileText, File, X, ArrowUpRight, ArrowDownLeft, CheckCircle, Loader2, SquarePen, Trash2, ArrowDownToLine, Users, UserPlus, User, Zap, Globe, Clock, ExternalLink, Activity as ActivityIcon, Receipt } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { Avatar } from '@/components/ui/Avatar'
import { Input } from '@/components/ui/Input'
import { Sheet } from '@/components/ui/Sheet'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import {formatAmount} from '@/lib/utils'
import { amountFontSize } from '@/lib/amountFontSize'
import { useSettingsStore } from '@/store/settingsStore'
import { isCoinEnabled } from '@/lib/featureFilters'
import { useAuthStore, useUIStore, useWalletStore, useChatUnreadStore } from '@/store'
import {
  supabase,
  fetchConversations,
  fetchContactsDb,
  addContactDb,
  searchUsersDb,
  invalidateConversationsCache,
  type DbConversation,
  type DbUser,
} from '@/lib/supabase'
import { decryptText, isEncryptedPayload } from '@/lib/chatCrypto'
import {
  loadMessages,
  ensureConversation,
  persistMessage,
  touchConversation,
  markRead,
  subscribeWithRetry,
  type ChatMessage,
} from '@/lib/chatService'
import { codeFromLink, paymentLink, orderLabel, BILL_PAY_EVENT, type PaymentView } from '@/lib/merchantPay'
import { useMerchant } from '@/lib/merchant'
import { InvoiceComposer } from '@/features/merchant/InvoiceComposer'
import { MerchantPaymentCard } from '@/features/merchant/MerchantPaymentCard'
import { ChatPendingOrders } from '@/features/merchant/ChatPendingOrders'
import { fetchMerchantFlags } from '@/lib/merchantPay'
import { PayLinkCard } from './PayLinkCard'
import { parsePersonalPayLink, PAY_LINK_EVENT, type PersonalPayLink } from '@/lib/payLinks'

// ─── Hidden chats helpers — wallet-scoped so Wallet A hidden chats never bleed into Wallet B
function hiddenKey(addr: string | null) {
  return addr ? `meshport_hidden_chats_${addr.toLowerCase()}` : 'meshport_hidden_chats_anon'
}

// Module-level cache
// Module-level cache — survives navigation, cleared on logout
let _cachedConversations: DbConversation[] = []
let _cacheLoadedForUser: string | null = null

// Instantly zero out a conversation's unread badge in the shared cache the
// moment its thread is opened, so if the user backs out to the chat list
// right away the badge is already gone — no waiting on a realtime round trip.
function markConversationReadLocally(conversationId: string): number {
  let cleared = 0
  _cachedConversations = _cachedConversations.map(c => {
    if (c.id === conversationId && (c.unread_count || 0) > 0) {
      cleared = c.unread_count || 0
      // Remember that this conversation was just read, and as-of which
      // last_message_at — see _readOverrides below for why.
      _readOverrides[conversationId] = {
        since: c.last_message_at ? new Date(c.last_message_at).getTime() : Date.now(),
        expiresAt: Date.now() + 5000,
      }
      return { ...c, unread_count: 0 }
    }
    return c
  })
  return cleared
}

// ChatListPage always does a fresh server refetch on mount (see the
// invalidateConversationsCache() + loadConversations() call below) — that's
// correct in general (something could've changed while the page wasn't
// mounted), but it used to race the *deliberately delayed* markRead() DB
// write (see ChatConversationPage: markRead only fires ~1.2s after opening a
// thread, on purpose, so a quick glance-and-leave doesn't count as "read").
// If you backed out to the list within that window, the refetch would
// overwrite the just-cleared badge with the still-unread count from the DB,
// and it'd only flip back to 0 once the delayed write finally landed —
// a visible flicker instead of staying instantly read, like WhatsApp does.
//
// This map remembers "conversation X was just read locally, as of
// last_message_at Y" so a refetch can tell the difference between "still
// unread because my markRead hasn't landed yet" (safe to keep showing 0)
// and "unread again because a genuinely new message arrived after I read
// it" (must NOT be suppressed). Entries self-clear once the server confirms
// the read (unread_count comes back 0), once real new activity arrives
// (last_message_at moves past `since`), or after 5s regardless, so this
// can never permanently mask a real unread badge.
const _readOverrides: Record<string, { since: number; expiresAt: number }> = {}
function applyReadOverrides(convs: DbConversation[]): DbConversation[] {
  const now = Date.now()
  return convs.map(c => {
    const ov = _readOverrides[c.id]
    if (!ov) return c
    if (now > ov.expiresAt) { delete _readOverrides[c.id]; return c }
    const lastMsgTime = c.last_message_at ? new Date(c.last_message_at).getTime() : 0
    if (lastMsgTime > ov.since) { delete _readOverrides[c.id]; return c } // genuine new activity — trust the server
    if (!c.unread_count) { delete _readOverrides[c.id]; return c } // server has confirmed the read already
    return { ...c, unread_count: 0 }
  })
}
const _cachedMessages: Record<string, ChatMessage[]> = {}
const _cachedOtherUser: Record<string, any> = {}

// ─── Linkify plain-text message content ───────────────────────────────────────
// Message bubbles previously rendered raw text content directly (see the
// final `: msg.content` fallback in MessageBubble below) — a pasted URL was
// just inert text: not underlined, not tappable, no way to open it, and
// worse, the WHOLE bubble has onTouchStart wired to a long-press handler
// (for the Forward/Delete/Copy context menu) with userSelect: 'none', so a
// tap on what LOOKED like a link either did nothing or triggered that
// context menu instead — reported as a shared link "going outside the
// conversation" instead of opening. This finds URLs in the text and wraps
// each one in a real, tappable <a> (opens in a new tab, matching WhatsApp's
// own link behavior — the app itself is never navigated away from), with
// event propagation stopped so a tap on the link can't also trigger the
// bubble's long-press/selection handling.
const URL_PATTERN = /(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+\.[a-z]{2,}[^\s<>"')\]]*)/gi

export function linkifyText(text: string, isMine: boolean): ReactNode {
  const parts = text.split(URL_PATTERN)
  if (parts.length === 1) return text // no URL found — plain text, unchanged

  // `split` with a single-capturing-group regex interleaves the captured
  // matches into the result at ODD indices (0: text, 1: match, 2: text,
  // 3: match, ...) — using that directly, rather than re-testing each part
  // against the same global regex object, sidesteps the regex's own
  // stateful `lastIndex` (which a repeated `.test()` call would otherwise
  // have to carefully reset between parts, and is easy to get wrong).
  return parts.map((part, i) => {
    if (i % 2 === 0) return part
    const href = part.startsWith('http') ? part : `https://${part}`
    return (
      <a
        key={i}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        style={{
          color: isMine ? '#fff' : 'var(--brand)',
          textDecoration: 'underline',
          textDecorationColor: isMine ? 'rgba(255,255,255,0.6)' : undefined,
          wordBreak: 'break-all',
          WebkitUserSelect: 'text',
          userSelect: 'text',
        }}
      >
        {part}
      </a>
    )
  })
}

// Lets other pages (HomePage's search results, Contacts, wherever a full
// user object is already on hand before navigating into a chat) warm this
// cache BEFORE the conversation screen ever mounts. Previously this cache
// was only ever written from inside ChatPage.tsx itself, after a
// conversation had already been opened once — meaning the very first time
// you opened a chat via any of those other entry points (not the Chats
// list itself), there was nothing to read yet and the header still
// flickered in, even after messages/otherUser were made cache-aware.
export function cacheOtherUser(userId: string, userData: any) {
  if (userId && userData) _cachedOtherUser[userId] = userData
}
// Hidden chats are stored as { [conversationId]: hiddenAtISOString } so we can
// tell whether a chat was hidden *before* new activity happened on it (e.g. a
// payment arriving while the Chats tab wasn't open) and auto-restore it. A
// plain id list can't distinguish "still deserves to be hidden" from
// "something new came in after I hid this" — which used to leave a chat
// permanently hidden even after a fresh payment/message came in, since the
// live auto-restore subscription only fires while the Chats page is mounted.
function getHiddenChatsMap(addr: string | null): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(hiddenKey(addr)) || '{}')
    // Back-compat: older versions stored a plain array of ids with no timestamp.
    if (Array.isArray(raw)) {
      const migrated: Record<string, string> = {}
      const nowIso = new Date(0).toISOString() // treat legacy hides as "hidden forever ago" so any existing activity restores them
      for (const id of raw) migrated[id] = nowIso
      return migrated
    }
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
function getHiddenChats(addr: string | null): Set<string> {
  return new Set(Object.keys(getHiddenChatsMap(addr)))
}
function hideChat(convId: string, addr: string | null) {
  const m = getHiddenChatsMap(addr); m[convId] = new Date().toISOString()
  localStorage.setItem(hiddenKey(addr), JSON.stringify(m))
}
function unhideChat(convId: string, addr: string | null) {
  const m = getHiddenChatsMap(addr); delete m[convId]
  localStorage.setItem(hiddenKey(addr), JSON.stringify(m))
}

// ─── ChatPay token display helpers ──────────────────────────────────────────
// USDC/EURC are both ~$1-pegged, so 3 decimals used to read fine — but that
// cap also silently rounded away dust-size ChatPay amounts (e.g. a real
// 0.000004 USDC payment showed as "$0" on the payment card and in history).
// Now that formatAmount (lib/utils.ts) trims trailing zeros on every
// display, there's no downside to using full 8-decimal precision for every
// token — a normal "5 USDC" still renders as "5" — so this now matches
// AmountKeypad.tsx's decimalCap and PaySendPage.tsx's tokenDisplayDecimals
// (both also raised to 8 for every token).
export type ChatPayToken = 'USDC' | 'EURC' | 'cirBTC'
// USDC/EURC: 6 decimals (their on-chain precision). cirBTC: 8.
export function chatPayTokenDecimals(t: ChatPayToken): number {
  return t === 'cirBTC' ? 8 : 6
}
export function chatPayTokenSymbolChar(t: ChatPayToken): string {
  return t === 'USDC' ? '$' : t === 'EURC' ? '€' : '₿'
}
export function chatPayTokenIconBg(t: ChatPayToken): string {
  return t === 'USDC' ? 'var(--usdc-icon)' : t === 'EURC' ? 'var(--brand)' : '#F7931A'
}

// ─── Chat List ─────────────────────────────────────────────────────────────────
// ─── Conversation list preview text — decrypts before classifying ───────────
// Same classification/transform logic the inline IIFE used to run
// synchronously on conv.last_message — now async because that value may be
// E2E-encrypted ciphertext (see chatCrypto.ts) that has to be decrypted
// first. A tiny standalone component (not a plain function) so it can hold
// its own decrypt-in-progress state via useEffect, the same reason
// EncryptedImage above is its own component rather than inlined.
//
// Pure "Sent X TOKEN to y.arc" → "Received X TOKEN from z.arc" perspective
// rewriter, extracted out of ConversationPreview below so it's testable the
// same way linkifyText is (a plain function, no hooks/JSX dependency) --
// see ChatPage.linkify.test.tsx's own comment on this repo's Node-only, no-
// jsdom test setup, which is exactly why this couldn't be tested while it
// lived inline inside a component.
export function formatPaymentMessagePreview(msg: string, opts: {
  isSelfChat: boolean
  uname: string
  myId: string | undefined
  lastMessageSender: string | null | undefined
  myUsername: string
}): string {
  const { isSelfChat, uname, myId, lastMessageSender, myUsername } = opts

  // A bill / order payment carries a trailing " · Order #ORD-100001" (older
  // ones " · Bill #ABC123") — rewrite the
  // payment part as usual and put the bill tag back on the end.
  const billTag = / · (?:Bill|Order) #[A-Z0-9-]{6,20}$/.exec(msg)
  if (billTag) {
    return formatPaymentMessagePreview(msg.slice(0, billTag.index), opts) + billTag[0]
  }

  // Only process payment messages. BUG FIX: this used to hardcode
  // `msg.includes(' USDC ')` -- a "Sent X EURC to y.arc" or "Sent X cirBTC
  // to y.arc" message (see executeChatPayment's payContent below) never
  // matched, so the recipient's side of the conversation showed the raw
  // sender-authored text verbatim ("Sent 5 cirBTC to bob.arc") instead of
  // the corrected "Received 5 cirBTC from alice.arc" -- wrong perspective,
  // not just a missed cirBTC label.
  if (!msg.startsWith('Sent ') || !/ (USDC|EURC|cirBTC) /.test(msg)) return msg

  // Self-chat: "sent to sunil.arc" and "received from
  // sunil.arc" are both literally true at once (the
  // raw stored content is your own username either
  // way — see the trueSender comment in
  // fetchConversations, supabase.ts). Showing your
  // own username as if it were a separate recipient
  // reads like you're chatting with someone else,
  // which is exactly wrong here. Swap the trailing
  // "to X" for "to You", matching the title fix above
  // and the self-transfer convention used everywhere
  // else in the app (Contacts, Send, Activity).
  if (isSelfChat) return msg.replace(/ to [\S]+$/, ' to You')

  // Strategy 1: use last_message_sender if available (new records)
  if (lastMessageSender) {
    if (lastMessageSender === myId) {
      // I sent it — keep message unchanged
      return msg
    }
    // Someone else sent it → I received it
    return msg.replace(/^Sent /, 'Received ').replace(/ to [\S]+$/, ` from ${uname}.arc`)
  }

  // Strategy 2 (old records with null sender): parse recipient
  // from "Sent X USDC to recipient.arc" and compare against my own username
  const toMatch = msg.match(/ to ([\w.]+)\.arc/i)
  const recipient = (toMatch?.[1] || '').toLowerCase()

  if (myUsername && recipient && recipient === myUsername) {
    // Message says "Sent X to ME.arc" — so they sent it, I received it
    return msg.replace(/^Sent /, 'Received ').replace(/ to [\S]+$/, ` from ${uname}.arc`)
  }

  // Recipient is someone else — I sent it, keep unchanged
  return msg
}

function ConversationPreview({ conv, isSelfChat, uname, userId }: {
  conv: any; isSelfChat: boolean; uname: string; userId: string | undefined
}) {
  const raw = conv.last_message || (isSelfChat ? 'You' : `${uname}.arc`)
  const [msg, setMsg] = useState<string>(() => (isEncryptedPayload(raw) ? raw : raw))
  // Reactive, not getState() — same fix as ChatPage's convKey effect below:
  // reading walletAddress once via getState() meant the preview got stuck
  // on the "🔒 New message" fallback for good if the Chats list rendered
  // before the wallet address finished loading, since nothing re-ran the
  // effect once the address actually became available.
  const walletAddress = useAuthStore((s) => s.walletAddress)
  const walletKeyReady = useAuthStore((s) => !!s.privateKey)
  useEffect(() => {
    if (!isEncryptedPayload(raw)) { setMsg(raw); return }
    let cancelled = false
    const otherId = conv.other_user?.id
    if (!walletAddress || !otherId) { setMsg('🔒 New message'); return }
    import('@/lib/chatCrypto').then(async ({ getConversationKey }) => {
      const key = await getConversationKey(walletAddress, otherId)
      const decrypted = await decryptText(raw, key)
      if (!cancelled) setMsg(decrypted)
    })
    return () => { cancelled = true }
  }, [raw, conv.other_user?.id, walletAddress, walletKeyReady])

  // Image/file messages store a raw markdown-style URL — show a clean label instead
  const previewCaption = splitCaption(msg).caption
  if (msg.startsWith('[IMAGE](') || msg.startsWith('[IMAGE-E:')) return <>📷 {previewCaption || 'Photo'}</>
  if (msg.startsWith('[FILE:') || msg.startsWith('[FILE-E:')) {
    let fname = msg.match(/^\[FILE:(.+?)\]\(/)?.[1] || msg.match(/^\[FILE-E:(.+?):/)?.[1]
    try { if (fname) fname = decodeURIComponent(fname) } catch { /* plain name */ }
    return <>{previewCaption ? `📎 ${previewCaption}` : fname ? `📎 ${fname}` : '📎 File'}</>
  }

  const myUsername = (
    (useAuthStore.getState().user as any)?.username
      || (useAuthStore.getState().user as any)?.arc_username
      || ''
  ).replace(/\.arc$/i, '').toLowerCase()

  return <>{formatPaymentMessagePreview(msg, {
    isSelfChat, uname, myId: userId, lastMessageSender: conv.last_message_sender, myUsername,
  })}</>
}

export function ChatListPage() {
  const navigate = useNavigate()
  const user          = useAuthStore(s => s.user)
  const chatWalletAddr = useAuthStore(s => s.walletAddress)
  const [search, setSearch] = useState('')
  // Search box tucks away while scrolling down the chat list, back on scroll up.
  const chatListScrollRef = useRef<HTMLDivElement>(null)
  const [chatSearchFocused, setChatSearchFocused] = useState(false)
  const chatSearchHidden = useHideOnScroll(chatListScrollRef, chatSearchFocused || !!search)
  const [conversations, setConversations] = useState<DbConversation[]>(_cachedConversations)
  const [loading, setLoading] = useState(_cachedConversations.length === 0)
  const [newChatSearch, setNewChatSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [showNewChat, setShowNewChat] = useState(false)
  const [showContacts, setShowContacts] = useState(false)
  const [savedContacts, setSavedContacts] = useState<DbUser[]>([])
  const [contactsLoading, setContactsLoading] = useState(true)
  const [addContactSearch, setAddContactSearch] = useState('')
  const [addContactResults, setAddContactResults] = useState<any[]>([])
  const [addContactSearching, setAddContactSearching] = useState(false)
  const [searching, setSearching] = useState(false)

  // Long-press context menu
  const [contextConv, setContextConv] = useState<DbConversation | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Profile sheet
  const [profileConv, setProfileConv] = useState<DbConversation | null>(null)

  // Load conversations, filtering out hidden ones
  useEffect(() => {
    if (!user?.id) return
    // Belt-and-suspenders alongside the nav badge's own cache invalidation
    // (see BottomNav.tsx) — every fresh mount of this page should be a
    // genuinely current read, since anything could have changed while this
    // page wasn't mounted at all (e.g. a message arrived while you were on
    // Home) and there's no guarantee some other listener already busted
    // the cache before you navigated here.
    invalidateConversationsCache()
    loadConversations()

    const unsubscribe = subscribeWithRetry(supabase, 'chat-list-' + user.id, channel => channel
      .on('postgres_changes', { event: 'INSERT',  schema: 'public', table: 'messages' }, () => { invalidateConversationsCache(); loadConversations() })
      // BUG FIX (desktop chat-list flicker): this used to unconditionally
      // invalidateConversationsCache() + loadConversations() on EVERY
      // messages UPDATE — including the read-receipt write that fires the
      // instant you open a chat (see ChatConversationPage's markRead call).
      // On mobile that full-list refetch happens off-screen, since the list
      // isn't visible while a conversation is open, so it was never
      // noticed. On desktop (ChatDesktopSplit) the list stays visible the
      // whole time in the persistent left column, so opening ANY chat
      // visibly reloaded and re-rendered the entire list right next to it
      // — i.e. clicking a chat card also changed the "user cards column",
      // when only the right-side conversation pane should have changed.
      // A read-receipt update only ever needs to clear ONE conversation's
      // unread badge, so do that directly in local state (same pattern as
      // markConversationReadLocally above) instead of round-tripping the
      // whole list through the network. Any other messages UPDATE (rare —
      // e.g. a future edit/delete flag) still falls back to the original
      // full refetch, so nothing besides this one common case changes.
      .on('postgres_changes', { event: 'UPDATE',  schema: 'public', table: 'messages' }, (payload: any) => {
        const msg = payload?.new
        if (msg?.conversation_id && msg?.is_read) {
          setConversations(prev => {
            const next = prev.map(c => (c.id === msg.conversation_id && c.unread_count) ? { ...c, unread_count: 0 } : c)
            _cachedConversations = next
            return next
          })
          return
        }
        // A delivery receipt (two grey ticks) changes nothing in the list.
        if (msg?.delivered_at && !msg?.is_read && msg?.content !== '[deleted]') return
        invalidateConversationsCache()
        loadConversations()
      })
      // Re-fetch conversations when any user profile updates (avatar, display name)
      .on('postgres_changes', { event: 'UPDATE',  schema: 'public', table: 'users' },    () => { invalidateConversationsCache(); loadConversations() }),
      // Catch up on anything missed during a drop (a message that arrived
      // while the socket was down) the moment the connection comes back —
      // without this, the list wouldn't refresh again until the next
      // unrelated change event happened to fire.
      { onReconnect: () => { invalidateConversationsCache(); loadConversations() } },
    )

    return unsubscribe
  }, [user?.id])

  const loadConversations = useCallback(async () => {
    if (!user?.id) return
    // Only show spinner if this user has no cached conversations yet
    if (_cacheLoadedForUser !== user.id) setLoading(true)
    const convs = applyReadOverrides(await fetchConversations(user.id))
    const hiddenMap = getHiddenChatsMap(chatWalletAddr)
    // A conversation stays hidden only if nothing has happened on it since it
    // was hidden. If a payment or message landed afterwards (last_message_at
    // is newer than the hide timestamp), surface it again automatically —
    // this is what makes a payment from a previously-removed contact show up
    // in Chats even if this page wasn't open when it arrived.
    let hiddenChanged = false
    const filtered = convs.filter(c => {
      const hiddenAt = hiddenMap[c.id]
      if (!hiddenAt) return true
      const isNewer = c.last_message_at && new Date(c.last_message_at).getTime() > new Date(hiddenAt).getTime()
      if (isNewer) { delete hiddenMap[c.id]; hiddenChanged = true; return true }
      return false
    })
    if (hiddenChanged) localStorage.setItem(hiddenKey(chatWalletAddr), JSON.stringify(hiddenMap))
    // Save to module-level cache so next mount is instant
    _cachedConversations = filtered
    _cacheLoadedForUser  = user.id
    setConversations(filtered)
    setLoading(false)

    // ── Background prefetch — the reason opening a chat previously always
    // showed a spinner ──────────────────────────────────────────────────
    // There was already a small prefetch trick on each row (onTouchStart
    // kicked off loadMessages a beat before the tap registered), but that
    // only gives ~100ms head start — nowhere near enough time for a full
    // network round trip, so the spinner still showed almost every time.
    // WhatsApp/Telegram feel instant because they preload chats
    // *proactively* the moment the list itself loads, not *reactively*
    // when you touch a row. This does the same: quietly fetch the top few
    // conversations' messages in the background right now, staggered so it
    // doesn't fire a burst of simultaneous requests, so that by the time
    // someone actually taps in, the data's very likely already cached.
    const toPrefetch = filtered.filter(c => !_cachedMessages[c.id]).slice(0, 8)
    toPrefetch.forEach((c, i) => {
      setTimeout(() => {
        loadMessages(c.id).then(msgs => { if (msgs.length) _cachedMessages[c.id] = msgs }).catch(() => {})
      }, i * 150)
    })
  }, [user?.id, chatWalletAddr])

  // This session was just linked to the account — conversations that the
  // database hid before the link are readable now.
  useEffect(() => {
    const on = () => { invalidateConversationsCache(); loadConversations() }
    window.addEventListener('meshport:session-bound', on)
    return () => window.removeEventListener('meshport:session-bound', on)
  }, [loadConversations])

  // When a new message arrives in a hidden chat, auto-restore it
  useEffect(() => {
    if (!user?.id) return
    const unsubscribe = subscribeWithRetry(supabase, 'chat-restore-' + user.id, channel => channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload: any) => {
        const msg = payload.new
        if (!msg?.conversation_id) return
        const hidden = getHiddenChats(chatWalletAddr)
        if (hidden.has(msg.conversation_id)) {
          // Fully restore the conversation — unhide and reload
          unhideChat(msg.conversation_id, chatWalletAddr)
          invalidateConversationsCache()
          await loadConversations()
        }
      })
    )
    return unsubscribe
  }, [user?.id])

  // Search users to start new chat — exact .arc match only
  useEffect(() => {
    const q = newChatSearch.trim()
    if (!q) { setSearchResults([]); return }
    // Only search when full .arc suffix is present
    if (!q.toLowerCase().endsWith('.arc')) { setSearchResults([]); return }
    setSearching(true)
    const timer = setTimeout(() => {
      // Pass full "username.arc" — searchUsersDb handles exact match
      searchUsersDb(q, user?.id).then(results => {
        setSearchResults(results)
        setSearching(false)
      }).catch(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [newChatSearch, user?.id])

  // Search for new contact by full username.arc
  useEffect(() => {
    const q = addContactSearch.trim()
    if (!q || !q.toLowerCase().endsWith('.arc')) { setAddContactResults([]); return }
    setAddContactSearching(true)
    const timer = setTimeout(() => {
      searchUsersDb(q, user?.id).then(r => { setAddContactResults(r); setAddContactSearching(false) }).catch(() => setAddContactSearching(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [addContactSearch, user?.id])

  // Load contacts on mount — saved contacts + anyone with a conversation, merged & sorted A-Z, excluding removed.
  // Reuses the `conversations` state the main chat list already loads (and
  // keeps live via realtime) instead of calling fetchConversations again —
  // that duplicate call was firing the same expensive batched query twice
  // on every single Chats page load, which is what made the contacts sheet
  // feel slow to open: it was waiting on a second, entirely redundant fetch.
  useEffect(() => {
    if (!user?.id) return
    import('@/lib/removedContacts').then(({ getRemovedContacts }) => {
      const removed = getRemovedContacts(chatWalletAddr)
      fetchContactsDb(user.id).catch(() => [] as DbUser[]).then(saved => {
        const merged = new Map<string, DbUser>()
        for (const c of saved) if (!removed.has(c.id)) merged.set(c.id, c)
        for (const conv of conversations) {
          const other = conv.other_user
          if (other && !removed.has(other.id) && !merged.has(other.id)) merged.set(other.id, other)
        }
        const sorted = Array.from(merged.values()).sort((a, b) =>
          (a.display_name || a.username).localeCompare(b.display_name || b.username)
        )
        setSavedContacts(sorted)
        setContactsLoading(false)
      })
    })
  }, [user?.id, conversations])

  // "Merchant" tag on chats with approved merchant accounts.
  const [merchantIds, setMerchantIds] = useState<Set<string>>(() => new Set())
  const convOtherIds = conversations.map(c => c.other_user?.id).filter(Boolean).join(',')
  useEffect(() => {
    if (!convOtherIds) return
    let cancelled = false
    fetchMerchantFlags(convOtherIds.split(',')).then(ids => { if (!cancelled) setMerchantIds(ids) }).catch(() => {})
    return () => { cancelled = true }
  }, [convOtherIds])

  const startChat = async (otherId: string) => {
    if (!user?.id) return
    // Check local conversations state first — no DB call needed
    const existing = conversations.find(c =>
      c.other_user?.id === otherId
    )
    if (existing) {
      unhideChat(existing.id, chatWalletAddr)
      setShowContacts(false)
      setShowNewChat(false)
      navigate(`/chat/${existing.id}`)
      return
    }
    // No existing conversation — create one
    const convId = await ensureConversation(user.id, otherId)
    if (!convId) return
    unhideChat(convId, chatWalletAddr)
    setShowContacts(false)
    setShowNewChat(false)
    navigate(`/chat/${convId}`)
  }

  const handleRemoveFromChats = (conv: DbConversation) => {
    // Add other user to removed contacts blocklist
    const otherId = conv.other_user?.id
    if (otherId && chatWalletAddr) {
      import('@/lib/removedContacts').then(({ addRemovedContact }) => {
        addRemovedContact(chatWalletAddr, otherId)
      })
    }
    hideChat(conv.id, chatWalletAddr)
    setConversations(prev => prev.filter(c => c.id !== conv.id))
    setContextConv(null)
  }

  // Long press handlers
  const startLongPress = (conv: DbConversation) => {
    if (longPressTimer.current) return  // already started, don't double-fire
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      setContextConv(conv)
    }, 600)
  }
  const cancelLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }

  const filtered = search
    ? conversations.filter(c =>
        (c.other_user?.display_name || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.other_user?.username || '').toLowerCase().includes(search.toLowerCase())
      )
    : conversations

  return (
    <div ref={chatListScrollRef} className="flex-1 overflow-y-auto bg-bg">
      <div className="sticky top-0 z-20 bg-bg/95 backdrop-blur-md px-5 pt-header pb-3">
        <div className="header-row justify-between" style={{ marginBottom: chatSearchHidden ? 0 : 16, transition: 'margin 0.25s ease' }}>
          <h1 className="text-xl font-bold text-text-primary">Chats</h1>
          <motion.button whileTap={{ scale: 0.9 }}
            onClick={() => setShowContacts(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--brand) 15%, transparent)' }}>
            <Users className="w-4 h-4 text-brand" />
          </motion.button>
        </div>

        {/* Search bar */}
        <div style={collapseStyle(chatSearchHidden, 56)}>
        <div className="flex items-center gap-2.5 px-3 py-2 rounded-full" style={{ background:'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
          <Search className="w-4 h-4 text-text-secondary flex-shrink-0" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            onFocus={() => setChatSearchFocused(true)} onBlur={() => setChatSearchFocused(false)}
            placeholder="Search"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-secondary focus:outline-none" />
          {search && (
            <button onClick={() => setSearch('')} className="text-text-secondary active:text-gray-300">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        </div>
      </div>



      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 px-5">
          <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-4">
            <Send className="w-8 h-8 text-text-secondary" />
          </div>
          <p className="text-text-secondary font-medium">No conversations yet</p>
          <p className="text-text-muted text-sm mt-1">Start a new conversation below</p>
          <button onClick={() => setShowNewChat(true)}
            className="mt-4 px-4 py-2 btn-primary text-sm px-4 py-2 rounded-2xl">
            New Contact
          </button>
        </div>
      ) : (
        <div className="pb-4">
          {filtered.map((conv, idx) => {
            // A self-conversation (paying/messaging your own username) has
            // conv.other_user resolved to your OWN user record — see
            // fetchConversations's otherIdByConv in supabase.ts, which
            // returns participant_b when participant_a === myId, and in a
            // self-chat participant_b === myId too. Showing your own real
            // name/username here reads as if you were chatting with a
            // separate contact, which is exactly what this card is not —
            // "You" matches the self-transfer labeling already used
            // everywhere else in the app (Contacts, Send, Activity list —
            // see BulkPayoutPage.tsx's own comment on this same
            // convention).
            const isSelfChat = !!(user?.id && conv.other_user?.id === user.id)
            const name   = isSelfChat ? 'You' : (conv.other_user?.display_name || 'Unknown')
            const uname  = isSelfChat ? 'you' : (conv.other_user?.username || '').replace(/\.arc$/, '')
            const unread = conv.unread_count || 0
            const d      = new Date(conv.last_message_at)
            const now    = new Date()
            const isToday    = d.toDateString() === now.toDateString()
            const isYesterday = d.toDateString() === new Date(now.getTime()-86400000).toDateString()
            const timeLabel  = isToday
              ? d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
              : isYesterday ? 'Yesterday'
              : d.getFullYear() === now.getFullYear()
                ? d.toLocaleDateString([], {month:'short',day:'numeric'})
                : d.toLocaleDateString([], {month:'short',day:'numeric',year:'2-digit'})
            return (
              // Plain <button>, not motion.button with a mount fade-in —
              // ChatDesktopSplit already keeps this whole list mounted as a
              // stable element separate from the conversation panel (which
              // lives behind its own <Outlet/>), so switching between
              // conversations never remounts these rows in the first place.
              // The fade only ever risked replaying visibly if this list
              // ever re-renders for an unrelated reason (e.g. a read-status
              // resort) — removing it entirely guarantees the cards never
              // animate on their own, only the conversation panel changes.
              <button key={conv.id}
                onClick={() => navigate(`/chat/${conv.id}`)}
                onMouseEnter={() => { if (!_cachedMessages[conv.id]) loadMessages(conv.id).then(msgs => { if (msgs.length) _cachedMessages[conv.id] = msgs }).catch(() => {}) }}
                onTouchStart={(e) => {
                  if (!_cachedMessages[conv.id]) loadMessages(conv.id).then(msgs => { if (msgs.length) _cachedMessages[conv.id] = msgs }).catch(() => {})
                  startLongPress(conv)
                }}
                onTouchEnd={(e) => { cancelLongPress() }}
                onTouchCancel={cancelLongPress}
                onContextMenu={e => e.preventDefault()}
                className="flex items-center gap-3 px-4 py-3 w-full active:bg-[rgb(var(--text-primary-rgb)/0.05)] transition-colors"
                style={{ borderBottom: idx < filtered.length-1 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none' }}>
                {/* Avatar — tap to open profile */}
                <div className="relative flex-shrink-0"
                  onClick={e => { e.stopPropagation(); setProfileConv(conv) }}>
                  <Avatar name={name} src={conv.other_user?.avatar_url} size="lg" className="!w-[52px] !h-[52px]" />
                </div>
                <div className="flex-1 min-w-0 text-left">
                  {/* Row 1: name + time */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[15px] font-semibold text-text-primary truncate">{name}</span>
                      {!isSelfChat && conv.other_user?.id && merchantIds.has(conv.other_user.id) && (
                        <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 py-[1px] rounded-md"
                          style={{ color: 'var(--brand)', background: 'color-mix(in srgb, var(--brand) 14%, transparent)' }}>
                          Merchant
                        </span>
                      )}
                    </div>
                    <p className={`text-[12px] flex-shrink-0 ${unread > 0 ? 'text-success font-semibold' : 'text-text-secondary'}`}>{timeLabel}</p>
                  </div>
                  {/* Row 2: last message + unread badge */}
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <p className={`text-[13px] truncate ${unread > 0 ? 'text-text-primary' : 'text-text-secondary'}`}>
                      <ConversationPreview conv={conv} isSelfChat={isSelfChat} uname={uname} userId={user?.id} />
                    </p>
                    {unread > 0 && (
                      <span className="min-w-[22px] h-[22px] px-1.5 bg-success rounded-full text-[11px] font-bold flex items-center justify-center text-white flex-shrink-0" style={{ lineHeight: 1 }}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* New Chat Sheet */}
      <Sheet isOpen={showNewChat} onClose={() => { setShowNewChat(false); setNewChatSearch(''); setSearchResults([]) }} title="New Contact" variant="center">
        <div className="px-5 py-4 space-y-4">
          <Input placeholder="username.arc (exact match)" value={newChatSearch}
            onChange={e => setNewChatSearch(e.target.value)}
            leftIcon={searching ? <div className="w-4 h-4 border border-brand border-t-transparent rounded-full animate-spin" /> : <Search className="w-4 h-4" />} />
          {searchResults.length > 0 ? (
            <div className="bg-surface rounded-2xl border border-border divide-y divide-border">
              {searchResults.map(u => (
                <button key={u.id} onClick={() => startChat(u.id)}
                  className="flex items-center gap-3 px-4 py-3 w-full hover:bg-[rgb(var(--text-primary-rgb)/0.05)] first:rounded-t-2xl last:rounded-b-2xl active:bg-[rgb(var(--text-primary-rgb)/0.10)]">
                  <Avatar name={u.display_name} src={u.avatar_url} size="sm" />
                  <div className="flex-1 text-left">
                    <UsernameDisplay username={u.username} size="sm" />
                    <p className="text-xs text-text-secondary mt-0.5">{u.display_name}</p>
                  </div>
                  <span className="text-xs text-brand font-medium px-2 py-1 bg-brand/10 rounded-lg">Message</span>
                </button>
              ))}
            </div>
          ) : newChatSearch && !newChatSearch.trim().toLowerCase().endsWith('.arc') ? (
            <p className="text-center text-sm text-text-secondary px-4">
              Enter full username (example: sunil.arc)
            </p>
          ) : newChatSearch && !searching ? (
            <p className="text-center text-sm text-text-secondary">No users found for &ldquo;{newChatSearch}&rdquo;</p>
          ) : null}
        </div>
      </Sheet>

      {/* ── Contacts Sheet ── */}
      <Sheet isOpen={showContacts} onClose={() => { setShowContacts(false); setAddContactSearch(''); setAddContactResults([]) }} title="Contacts">
        <div className="px-5 pb-6 space-y-3">
          {/* Inline search to add new contact */}
          <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
            <div className="flex items-center gap-2.5 px-4 py-3">
              {addContactSearching
                ? <Loader2 className="w-4 h-4 text-brand animate-spin flex-shrink-0" />
                : <Search className="w-4 h-4 text-text-secondary flex-shrink-0" />}
              <input
                value={addContactSearch}
                onChange={e => setAddContactSearch(e.target.value)}
                placeholder="Add contact — enter username.arc"
                className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-secondary focus:outline-none"
              />
              {addContactSearch && (
                <button onClick={() => { setAddContactSearch(''); setAddContactResults([]) }}>
                  <X className="w-4 h-4 text-text-secondary" />
                </button>
              )}
            </div>
            {addContactSearch && !addContactSearch.trim().toLowerCase().endsWith('.arc') && (
              <p className="text-xs text-text-secondary px-4 pb-3">Enter full username — e.g. sunil.arc</p>
            )}
            {addContactResults.map(u => (
              <button key={u.id}
                onClick={async () => {
                  if (!user?.id) return
                  await addContactDb(user.id, u.id).catch(() => {})
                  // Clear from removed blocklist — user explicitly re-added this person
                  const { removeFromRemovedContacts } = await import('@/lib/removedContacts')
                  removeFromRemovedContacts(chatWalletAddr, u.id)
                  setSavedContacts(prev => {
                    if (prev.some(c => c.id === u.id)) return prev
                    return [...prev, u].sort((a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username))
                  })
                  setAddContactSearch(''); setAddContactResults([])
                  startChat(u.id)
                }}
                className="w-full flex items-center gap-3 px-4 py-3 active:bg-[rgb(var(--text-primary-rgb)/0.05)] transition-colors"
                style={{ borderTop: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                <Avatar name={u.display_name} src={u.avatar_url} size="sm" />
                <div className="flex-1 text-left min-w-0">
                  <p className="text-[15px] font-semibold text-text-primary truncate">{u.display_name}</p>
                  <p className="text-[12px] font-mono mt-0.5 truncate text-link">{u.username}</p>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold"
                  style={{ background: 'color-mix(in srgb, var(--brand) 15%, transparent)', color: 'var(--brand)' }}>
                  <UserPlus className="w-3 h-3" /> Add
                </div>
              </button>
            ))}
          </div>

          {/* All saved contacts — scrolls inside Sheet */}
          {savedContacts.length > 0 ? (
            <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
              {savedContacts.map((c, i) => (
                <button key={c.id}
                  onClick={() => { setShowContacts(false); startChat(c.id) }}
                  className="w-full flex items-center gap-3 px-4 py-3 active:bg-[rgb(var(--text-primary-rgb)/0.05)] transition-colors text-left"
                  style={{ borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined }}>
                  <Avatar name={c.display_name || c.username} src={c.avatar_url} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-semibold text-text-primary truncate">{c.display_name || c.username}</p>
                    <p className="text-[12px] font-mono mt-0.5 truncate text-link">
                      {c.username?.endsWith('.arc') ? c.username : `${c.username}.arc`}
                    </p>
                  </div>
                  <Send className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--brand)' }} />
                </button>
              ))}
            </div>
          ) : contactsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--brand)' }} />
            </div>
          ) : (
            <div className="text-center py-6">
              <Users className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
              <p className="text-sm text-text-secondary">No contacts yet</p>
              <p className="text-xs text-text-muted mt-1">Search a username above to add</p>
            </div>
          )}
        </div>
      </Sheet>

      {/* ── Profile Sheet (from chat list avatar tap) ── */}
      <AnimatePresence>
        {profileConv && (() => {
          const pName  = profileConv.other_user?.display_name || 'Unknown'
          const pUname = (profileConv.other_user?.username || '').replace(/\.arc$/, '')
          return (
            <>
              <motion.div transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setProfileConv(null)} />
              <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={SHEET_SPRING}
                className="absolute bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-3xl pb-10">
                {/* Handle */}
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[rgb(var(--text-primary-rgb)/0.20)]" />
                </div>
                {/* Avatar + name */}
                <div className="flex flex-col items-center pt-4 pb-5 px-6">
                  <Avatar name={pName} src={profileConv.other_user?.avatar_url} size="xl" className="!w-[72px] !h-[72px] mb-3" />
                  <p className="text-[18px] font-bold text-text-primary flex items-center gap-1.5">
                    {pName}
                    
                  </p>
                  <p className="text-[13px] text-link mt-0.5">{pUname}.arc</p>
                  {profileConv.other_user?.wallet_address && (
                    <p className="text-[11px] text-text-muted mt-1 font-mono">
                      {profileConv.other_user.wallet_address.slice(0,6)}...{profileConv.other_user.wallet_address.slice(-6)}
                    </p>
                  )}
                </div>
                {/* Actions */}
                <div className="px-5 space-y-2.5">
                  {/* Message */}
                  <button
                    onClick={() => { setProfileConv(null); navigate(`/chat/${profileConv.id}`) }}
                    className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl active:scale-[0.98] transition-transform"
                    style={{ background:'color-mix(in srgb, var(--brand) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--brand) 20%, transparent)' }}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:'color-mix(in srgb, var(--brand) 20%, transparent)' }}>
                      <Send className="w-4 h-4 text-brand" />
                    </div>
                    <span className="text-[15px] font-semibold text-text-primary">Message</span>
                  </button>
                  {/* Remove contact */}
                  <button
                    onClick={() => { setProfileConv(null); handleRemoveFromChats(profileConv) }}
                    className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl active:scale-[0.98] transition-transform"
                    style={{ background:'color-mix(in srgb, var(--danger) 6%, transparent)', border:'1px solid color-mix(in srgb, var(--danger) 15%, transparent)' }}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
                      <Trash2 className="w-4 h-4 text-danger" />
                    </div>
                    <span className="text-[15px] font-semibold text-danger">Remove Contact</span>
                  </button>
                </div>
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      {/* Long-press context menu */}
      <AnimatePresence>
        {contextConv && (
          <>
            <motion.div transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm z-40"
              onClick={() => setContextConv(null)} />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={SHEET_SPRING}
              className="absolute bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-3xl px-5 pt-5 pb-10">
              {/* Contact preview */}
              <div className="flex items-center gap-3 mb-5 px-1">
                <Avatar name={contextConv.other_user?.display_name || 'User'} src={contextConv.other_user?.avatar_url} size="md" />
                <div className="min-w-0">
                  <p className="text-base font-bold text-text-primary truncate">{contextConv.other_user?.display_name || 'Unknown'}</p>
                  <p className="text-sm text-link">{(contextConv.other_user?.username || '').replace(/\.arc$/, '')}.arc</p>
                </div>
              </div>
              <button
                onClick={() => handleRemoveFromChats(contextConv)}
                className="w-full flex items-center gap-3 px-5 py-4 bg-danger/10 border border-danger/20 rounded-2xl text-danger font-semibold active:scale-95 transition-transform">
                <Trash2 className="w-5 h-5" />
                Remove from Contacts
              </button>
              <p className="text-center text-xs text-text-muted mt-3">History is preserved. It will reappear if you message again.</p>
              <button onClick={() => setContextConv(null)}
                className="w-full mt-3 px-5 py-3.5 bg-surface/60 rounded-2xl text-text-secondary font-semibold active:scale-95 transition-transform">
                Cancel
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Memoized unread-messages divider ────────────────────────────────────────
const UnreadDivider = memo(function UnreadDivider({ count }: { count: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
      transition={{ duration: 0.35, ease: 'easeInOut' }}
      className="flex items-center gap-3 my-4 px-2 relative z-[1] overflow-hidden"
    >
      <div className="flex-1 h-px bg-[rgb(var(--text-primary-rgb)/0.15)]" />
      <span className="text-[11px] font-bold text-link uppercase tracking-wide bg-surface border border-brand/30 rounded-full px-3 py-1 whitespace-nowrap">
        {count > 1 ? `${count} unread messages` : 'Unread message'}
      </span>
      <div className="flex-1 h-px bg-[rgb(var(--text-primary-rgb)/0.15)]" />
    </motion.div>
  )
})

// ─── Decrypted image bubble ──────────────────────────────────────────────────
// A plaintext [IMAGE](url) can just be an <img src>. An encrypted one
// [IMAGE-E:iv](url) points at ciphertext bytes at that URL — this fetches
// them, decrypts with the conversation key, and renders an object URL
// instead. Its own small component (not inlined in MessageBubble) so the
// fetch+decrypt only re-runs when THIS image's url/iv actually change, not
// on every unrelated re-render of the message list.
function EncryptedImage({ url, ivBase64, convKey, isLastInGroup, isMine, onTap }: {
  url: string; ivBase64: string; convKey: any; isLastInGroup: boolean; isMine: boolean
  onTap: (objectUrl: string) => void
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null
    ;(async () => {
      try {
        const { decryptBlob } = await import('@/lib/chatCrypto')
        const res = await fetch(url)
        const encryptedBytes = await res.arrayBuffer()
        const plainBlob = await decryptBlob(encryptedBytes, ivBase64, convKey)
        if (cancelled) return
        createdUrl = URL.createObjectURL(plainBlob)
        setObjectUrl(createdUrl)
      } catch (e) {
        console.error('[Chat] failed to decrypt image:', e)
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true; if (createdUrl) URL.revokeObjectURL(createdUrl) }
  }, [url, ivBase64, convKey])

  if (failed) {
    return (
      <div style={{ width: 200, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isMine ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)', fontSize: 12.5 }}>
        🔒 Couldn't decrypt this image
      </div>
    )
  }
  if (!objectUrl) {
    return (
      <div style={{ width: 200, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: isMine ? '#fff' : 'var(--brand)' }} />
      </div>
    )
  }
  return (
    <img
      src={objectUrl} alt="attachment" onClick={() => onTap(objectUrl)}
      style={{
        display: 'block', width: '100%', minWidth: 140, maxWidth: 260, maxHeight: 320,
        objectFit: 'cover', cursor: 'pointer',
        borderRadius: isLastInGroup ? (isMine ? '18px 18px 4px 18px' : '18px 18px 18px 4px') : '18px',
      }}
    />
  )
}

// ─── Memoized message bubble — only re-renders if message itself changes ─────
// "Delete for me": message ids are unique, so one list for every chat. Older
// builds kept a list per page address (meshport_deleted_<route id>) — those
// are still read, so nothing deleted earlier comes back.
const DELETED_FOR_ME_KEY = 'meshport_deleted_msgs'
function deletedForMe(): Set<string> {
  const out = new Set<string>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('meshport_deleted_')) continue
      for (const v of JSON.parse(localStorage.getItem(k) || '[]')) out.add(String(v))
    }
  } catch { /* storage unavailable */ }
  return out
}
function addDeletedForMe(ids: string[]) {
  try {
    const cur = new Set<string>(JSON.parse(localStorage.getItem(DELETED_FOR_ME_KEY) || '[]'))
    ids.forEach(i => cur.add(i))
    localStorage.setItem(DELETED_FOR_ME_KEY, JSON.stringify([...cur].slice(-5000)))
  } catch { /* storage unavailable */ }
}
function removeDeletedForMe(ids: string[]) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('meshport_deleted_')) continue
      const list: string[] = JSON.parse(localStorage.getItem(k) || '[]')
      const next = list.filter(v => !ids.includes(String(v)))
      if (next.length !== list.length) localStorage.setItem(k, JSON.stringify(next))
    }
  } catch { /* storage unavailable */ }
}

const DELETE_FOR_EVERYONE_MS = 2 * 24 * 3600 * 1000

/** WhatsApp ticks: clock (sending) · one tick (sent) · two grey (delivered) · two blue (read). */
export function messageStatus(msg: any): 'pending' | 'failed' | 'sent' | 'delivered' | 'read' {
  if (msg._failed) return 'failed'
  if (String(msg.id ?? '').startsWith('optimistic_')) return 'pending'
  if (msg.is_read || msg.read_at) return 'read'
  if (msg.delivered_at) return 'delivered'
  return 'sent'
}
function MessageTicks({ msg, onMedia }: { msg: any; onMedia?: boolean }) {
  const st = messageStatus(msg)
  const grey = onMedia ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.62)'
  const blue = '#53bdeb'
  if (st === 'failed') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff8a7a" strokeWidth="2.4" strokeLinecap="round" aria-label="Not sent"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>
  )
  if (st === 'pending') return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={grey} strokeWidth="2.2" strokeLinecap="round" aria-label="Sending"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
  )
  if (st === 'sent') return (
    <svg width="13" height="11" viewBox="0 0 14 12" fill="none" stroke={grey} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-label="Sent"><path d="M1.5 6.5L5 10l7.5-8" /></svg>
  )
  return (
    <svg width="17" height="11" viewBox="0 0 18 12" fill="none" stroke={st === 'read' ? blue : grey} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-label={st === 'read' ? 'Read' : 'Delivered'}><path d="M1 6.5l3.5 3.5L11 2.5" /><path d="M7 9.5l.6.5L15 2.5" /></svg>
  )
}

function DateSeparator({ iso }: { iso: string }) {
        const d    = new Date(iso)
        const now  = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const yest  = new Date(today.getTime() - 86400000)
        const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
        const label = msgDay.getTime() === today.getTime() ? 'Today'
          : msgDay.getTime() === yest.getTime() ? 'Yesterday'
          : msgDay.getFullYear() === now.getFullYear()
            ? d.toLocaleDateString([], {weekday:'long', month:'short', day:'numeric'})
            : d.toLocaleDateString([], {weekday:'long', month:'short', day:'numeric', year:'numeric'})
        return (
          <div className="flex items-center gap-2 my-3 px-4">
            <div className="flex-1 h-px bg-[rgb(var(--text-primary-rgb)/0.06)]"/>
            <span className="text-[11px] text-text-secondary font-medium px-2">{label}</span>
            <div className="flex-1 h-px bg-[rgb(var(--text-primary-rgb)/0.06)]"/>
          </div>
        )
      }

const MessageBubble = memo(function MessageBubble({
  msg, isMine, isPayment, showTime, isFirstInGroup, isLastInGroup, recipientClean, userId, onImageTap,
  onLongPress, onLongPressEnd, convKey, onRetry, onReply, getMsg, onJumpTo, otherName, onCancelUpload,
}: {
  msg: any, isMine: boolean, isPayment: boolean, showTime: boolean,
  isFirstInGroup: boolean, isLastInGroup: boolean,
  recipientClean: string, userId: string,
  onImageTap: (src: string, msgId?: string) => void
  convKey: any
  // Stable, unbound callbacks — msg/isMine are passed as call arguments
  // from inside this already-memoized component instead of the parent
  // pre-binding a fresh closure per message on every single render. That
  // pre-binding is what previously defeated memo() entirely: a new
  // function reference on every prop is, by React's shallow comparison,
  // indistinguishable from "this message actually changed" — so every
  // bubble re-rendered on every keystroke in the composer, every unrelated
  // state change anywhere in the parent, etc.
  onLongPress?: (msg: any, isMine: boolean) => void
  onLongPressEnd?: () => void
  /** Resend a message that failed to send. */
  onRetry?: (msg: any) => void
  /** Swipe right → reply to this message. */
  onReply?: (msg: any) => void
  /** Looks up a loaded message (for the quoted original). */
  getMsg?: (id: string) => any
  /** Scroll to a message and flash it (tap on a quote). */
  onJumpTo?: (id: string) => void
  otherName?: string
  /** Stop a photo / file that's still uploading. */
  onCancelUpload?: (msg: any) => void
}) {
  const isDeleted = msg.content === '[deleted]'

  // ── E2E decryption ──────────────────────────────────────────────────────
  // Every other prefix check below (`[IMAGE](`, `[FILE:`, etc.) has to run
  // against the DECRYPTED string, not the raw ciphertext — a ciphertext
  // blob obviously never matches any of those literal prefixes, which
  // would otherwise make every encrypted image/file silently fall through
  // to the plain-text rendering branch as a wall of base64. Legacy
  // plaintext (no e2e:v1: prefix — every message sent before this
  // feature existed) resolves instantly with no async delay at all.
  const [decryptedContent, setDecryptedContent] = useState<string>(() =>
    (isDeleted || !isEncryptedPayload(msg.content)) ? msg.content : (_plainByContent.get(msg.content) ?? '')
  )
  useEffect(() => {
    if (isDeleted || !isEncryptedPayload(msg.content)) { setDecryptedContent(msg.content); return }
    const cached = _plainByContent.get(msg.content)
    if (cached != null) { setDecryptedContent(cached); return }
    let cancelled = false
    decryptText(msg.content, convKey).then(d => {
      // Only a real decrypt is remembered — "unable to decrypt" (wallet key
      // not unlocked yet on this device) must be retried once the key is ready.
      if (!isDecryptFailure(d)) _plainByContent.set(msg.content, d)
      if (!cancelled) setDecryptedContent(d)
    })
    return () => { cancelled = true }
  }, [msg.content, convKey, isDeleted])

  const content = decryptedContent
  // Bills / payment requests are payment records — never deletable (the
  // content is only readable after decryption, so the check lives here).
  const isPaymentRecord = !!codeFromLink(content)
  const handleLongPressStart = () => { if (!isPaymentRecord) onLongPress?.(msg, isMine) }
  // A long-press only counts if the finger stays put — scrolling never selects.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  // Swipe right to reply (WhatsApp): only a clearly sideways drag counts, so
  // scrolling is never hijacked; past 56px, letting go replies.
  const swipeRef = useRef<HTMLDivElement>(null)
  const replyIconRef = useRef<HTMLDivElement>(null)
  const swipeRef2 = useRef<{ active: boolean; dx: number }>({ active: false, dx: 0 })
  const canSwipeReply = !!onReply && !isDeleted && !String(msg.id).startsWith('optimistic_') && !msg._failed
  const setSwipe = (dx: number, animate: boolean) => {
    const el = swipeRef.current, ic = replyIconRef.current
    if (el) { el.style.transition = animate ? 'transform 0.2s ease' : 'none'; el.style.transform = dx ? `translateX(${dx}px)` : '' }
    if (ic) { ic.style.transition = animate ? 'opacity 0.2s ease' : 'none'; ic.style.opacity = String(Math.min(1, dx / 56)); ic.style.transform = `scale(${dx >= 56 ? 1.1 : 0.8 + Math.min(0.2, dx / 280)})` }
  }
  const onTouchStartBubble = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null
    swipeRef2.current = { active: false, dx: 0 }
    handleLongPressStart()
  }
  const onTouchMoveBubble = (e: React.TouchEvent) => {
    const t = e.touches[0], s0 = touchStartRef.current
    if (!t || !s0) return
    const dx = t.clientX - s0.x, dy = t.clientY - s0.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) onLongPressEnd?.()
    if (!canSwipeReply) return
    if (!swipeRef2.current.active && dx > 12 && dx > Math.abs(dy) * 1.4) swipeRef2.current.active = true
    if (swipeRef2.current.active) {
      const d = Math.max(0, Math.min(80, dx))
      if (d >= 56 && swipeRef2.current.dx < 56) { try { navigator.vibrate?.(10) } catch { /* not supported */ } }
      swipeRef2.current.dx = d
      setSwipe(d, false)
    }
  }
  const onTouchEndBubble = () => {
    onLongPressEnd?.()
    if (swipeRef2.current.active) {
      if (swipeRef2.current.dx >= 56) onReply?.(msg)
      swipeRef2.current = { active: false, dx: 0 }
      setSwipe(0, true)
    }
  }
  // The quoted original (swipe-to-reply).
  const quoted = msg.reply_to_id ? getMsg?.(msg.reply_to_id) : null
  const quotedMine = !!quoted && quoted.sender_id === userId
  const quoteColor = quotedMine ? (isMine ? '#9be7c4' : 'var(--link)') : '#e7a36b'
  const quoteBlock = msg.reply_to_id && !isDeleted ? (
    <button type="button" onClick={e => { e.stopPropagation(); if (quoted) onJumpTo?.(msg.reply_to_id) }}
      style={{ display: 'block', width: '100%', minWidth: 'min(220px, 100%)', textAlign: 'left', border: 'none', cursor: quoted ? 'pointer' : 'default', marginBottom: 5, padding: '6px 6px 6px 9px', borderRadius: 8,
        background: isMine ? 'rgba(0,0,0,0.22)' : 'color-mix(in srgb, var(--text-primary) 7%, transparent)',
        borderLeft: `4px solid ${quoteColor}` }}>
      <QuoteBody quoted={quoted} convKey={convKey}
        name={quoted ? (quotedMine ? 'You' : (otherName || recipientClean)) : 'Message'} nameColor={quoteColor}
        textColor={isMine ? 'rgba(255,255,255,0.8)' : 'var(--text-secondary)'} />
    </button>
  ) : null
  // Payment for a merchant order / bill → shown as a reply to that card.
  const billRef = isPayment ? (/ · (?:Bill|Order) #([A-Z0-9-]{6,20})$/.exec(content)?.[1] ?? null) : null
  const billAnchor = billRef ? (billRef.startsWith('ORD-') ? `order-${billRef.toLowerCase()}` : `bill-${billRef.toLowerCase()}`) : null
  // A photo / file may carry a caption on the lines after its marker.
  const { media: mediaContent, caption } = splitCaption(content)
  const isEncryptedImage = mediaContent.startsWith('[IMAGE-E:')
  const isEncryptedFile  = mediaContent.startsWith('[FILE-E:')
  const plainImageUrl = /^\[IMAGE\]\(.+\)$/.test(mediaContent) ? mediaContent.slice(8, -1) : null
  const encImageMatch = isEncryptedImage ? mediaContent.match(/^\[IMAGE-E:(.+?)\]\((.+)\)$/) : null
  // [FILE-E:name:iv](url) — the iv (base64, no ':') is the LAST segment, so a
  // name containing ':' still parses. New names are URI-encoded when sent.
  const fileMatch = isEncryptedFile
    ? mediaContent.match(/^\[FILE-E:(.+):([^:\]]+)\]\((.+)\)$/)
    : mediaContent.startsWith('[FILE:') ? mediaContent.match(/^\[FILE:(.+?)\]\((.+)\)$/) : null // [FILE:name](url)
  const isImageMsg = !!(plainImageUrl || encImageMatch)

  return (
    <motion.div key={msg.id} id={`msg-${msg.id}`} className={isFirstInGroup ? 'mt-3' : 'mt-1'}
      // Only genuinely new live-arrival messages animate in — the initial
      // batch load and older-message pagination render with no transition
      // at all (instant, matching how they've always worked), since
      // animating all 50 initial messages in would look like an odd
      // cascade rather than a single message smoothly arriving. This is
      // exactly the "pop in with a flicker" bug: previously EVERY message,
      // new or not, was a plain div with zero transition, so a fresh
      // message arriving alongside a scroll adjustment at the same moment
      // read as an abrupt, jarring pop instead of a smooth appearance.
      initial={msg._isNewArrival ? { opacity: 0, y: 18 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      onMouseDown={handleLongPressStart} onMouseUp={onLongPressEnd} onMouseLeave={onLongPressEnd}
      onTouchStart={onTouchStartBubble} onTouchMove={onTouchMoveBubble} onTouchEnd={onTouchEndBubble} onTouchCancel={onTouchEndBubble}
      style={{ WebkitUserSelect: 'none', userSelect: 'none', position: 'relative' }}
    >
      {showTime && <DateSeparator iso={msg.created_at} />}
      {canSwipeReply && (
        <div ref={replyIconRef} aria-hidden="true"
          style={{ position: 'absolute', left: 4, bottom: 10, width: 28, height: 28, borderRadius: '50%', opacity: 0, pointerEvents: 'none',
            background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 016 6v4" /></svg>
        </div>
      )}
      <div ref={swipeRef}>
      {isPayment ? (
        <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} my-1.5`}>
          <div style={{
            position: 'relative', overflow: 'hidden', borderRadius: 16,
            padding: '9px 13px', width: 219, maxWidth: '85%',
            boxShadow: 'var(--shadow-1)',
            // SENT = brand (my payment going out), RECEIVED = success (money coming in).
            // Blended with the real surface color (not transparent) so the
            // card reads as solid card content against the wallpaper behind
            // it, rather than a faint tint the pattern shows through too
            // strongly — same color identity, just more grounded.
            background: isMine
              ? 'color-mix(in srgb, var(--brand) 18%, var(--surface))'
              : 'color-mix(in srgb, var(--success) 18%, var(--surface))',
            border: isMine
              ? '1px solid color-mix(in srgb, var(--brand) 35%, transparent)'
              : '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
          }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isMine ? 'color-mix(in srgb, var(--brand) 22%, transparent)' : 'color-mix(in srgb, var(--success) 22%, transparent)' }}>
                  {isMine
                    ? <ArrowUpRight className="w-3 h-3" style={{ color: 'var(--brand)' }} />
                    : <ArrowDownLeft className="w-3 h-3" style={{ color: 'var(--success)' }} />
                  }
                </div>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {billRef ? (isMine ? 'Order paid' : 'Payment received') : (isMine ? 'Paid' : 'Received')}
                </span>
              </div>
              <div style={{ width: 25, height: 25, borderRadius: '50%', border: isMine ? '2px solid color-mix(in srgb, var(--brand) 45%, transparent)' : '2px solid color-mix(in srgb, var(--success) 45%, transparent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CheckCircle className="w-3.5 h-3.5" style={{ color: isMine ? 'var(--brand)' : 'var(--success)' }} strokeWidth={2.5} />
              </div>
            </div>
            {billRef && (
              // Reply to the bill card this payment settles — tap to jump to it.
              <div onClick={() => document.getElementById(billAnchor!)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                style={{
                  position: 'relative', marginTop: 7, padding: '5px 8px', borderRadius: 8, cursor: 'pointer',
                  borderLeft: `3px solid ${isMine ? 'var(--brand)' : 'var(--success)'}`,
                  background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
                }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: isMine ? 'var(--brand)' : 'var(--success)' }}>{billRef.startsWith('ORD-') ? `Order #${billRef}` : `🧾 Bill #${billRef}`}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{isMine ? 'Paid in full' : 'Paid by customer'}</div>
              </div>
            )}
            <p style={{ position: 'relative', fontSize: 22, lineHeight: 1, fontWeight: 700, color: 'var(--text-primary)', marginTop: 5 }}>
              {formatAmount(msg.payment_amount || 0, chatPayTokenDecimals((msg.token_symbol as ChatPayToken) || 'USDC'))} <span style={{ fontSize: 16 }}>{msg.token_symbol || 'USDC'}</span>
            </p>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 4 }}>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{isMine ? 'To' : 'From'} {recipientClean}.arc</p>
              <p style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{new Date(msg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
            </div>
            {msg.payment_tx_hash && (
              <a href={`https://testnet.arcscan.app/tx/${msg.payment_tx_hash}`} target="_blank" rel="noopener noreferrer"
                style={{ position: 'relative', display: 'inline-block', fontSize: 10, color: isMine ? 'var(--brand)' : 'var(--success)', textDecoration: 'underline', marginTop: 5 }}>
                View on ArcScan →
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} gap-2`}>
          <div className={`relative overflow-hidden max-w-[78%] w-fit shadow-md ${
            isDeleted ? 'px-3.5 py-2' : (plainImageUrl || encImageMatch) ? 'p-[3px]' : 'px-3.5 py-2'
          } ${isMine
            ? `bg-brand ${isLastInGroup ? 'rounded-[18px] rounded-br-[4px]' : 'rounded-[18px]'}`
            : `bg-surface border border-border ${isLastInGroup ? 'rounded-[18px] rounded-bl-[4px]' : 'rounded-[18px]'}`
          }`}>
            {isDeleted && (
              <p className="text-[14px] italic" style={{ color: isMine ? 'rgba(255,255,255,0.6)' : 'var(--text-secondary)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>
                  {isMine ? 'You deleted this message' : 'This message was deleted'}
                </span>
              </p>
            )}
            {!isDeleted && msg.forwarded && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontStyle: 'italic', marginBottom: 2,
                padding: (plainImageUrl || encImageMatch) ? '6px 10px 2px' : 0,
                color: isMine ? 'rgba(255,255,255,0.72)' : 'var(--text-secondary)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 00-6 6v4" /></svg>
                Forwarded
              </div>
            )}
            {quoteBlock && (plainImageUrl || encImageMatch) ? <div style={{ padding: '1px 1px 0' }}>{quoteBlock}</div> : quoteBlock}
            {!isDeleted && <div className={`relative text-[15px] leading-snug ${isMine ? 'text-white' : 'text-text-primary'}`}>
              {(plainImageUrl || encImageMatch) ? (
                <>
                  <ChatImage
                    url={plainImageUrl ?? encImageMatch![2]} iv={encImageMatch ? encImageMatch[1] : null} convKey={convKey}
                    radius={caption ? '15px 15px 4px 4px' : (isLastInGroup ? (isMine ? '15px 15px 3px 15px' : '15px 15px 15px 3px') : '15px')} maxW={254}
                    upload={msg._upload ? { progress: msg._upload.progress, onCancel: () => onCancelUpload?.(msg) } : null}
                    failed={!!msg._failed} onRetry={() => onRetry?.(msg)}
                    onTap={local => onImageTap(local, msg.id)} />
                  {caption ? (
                    <div style={{ padding: '6px 10px 5px', maxWidth: 260, wordBreak: 'break-word' }}>
                      {linkifyText(caption, isMine)}
                      <div className="flex items-center justify-end gap-1 mt-0.5">
                        <p className={`text-[11px] ${isMine ? 'text-white/60' : 'text-text-secondary'}`}>{new Date(msg.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</p>
                        {isMine && <MessageTicks msg={msg} />}
                      </div>
                    </div>
                  ) : (
                  /* Time + ticks on the photo, bottom right (WhatsApp) */
                  <div style={{
                    position: 'absolute', bottom: 6, right: 8,
                    display: 'flex', alignItems: 'center', gap: 3,
                    background: 'rgba(0,0,0,0.45)', borderRadius: 10,
                    padding: '2px 6px', pointerEvents: 'none',
                  }}>
                    <span style={{ fontSize: 11, color: '#fff' }}>
                      {new Date(msg.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}
                    </span>
                    {isMine && <MessageTicks msg={msg} onMedia />}
                  </div>
                  )}
                </>
              ) : fileMatch ? (
                (() => {
                  // [FILE-E:name:iv](url) → [name, iv, url]; [FILE:name](url) → [name, url]
                  const isEncFile = fileMatch.length === 4
                  let fileName = fileMatch[1]
                  try { fileName = decodeURIComponent(fileName) } catch { /* legacy plain name */ }
                  const fileUrl = isEncFile ? fileMatch[3] : fileMatch[2]
                  const fileIv  = isEncFile ? fileMatch[2] : null
                  return (
                    <>
                      <ChatFile name={fileName} url={fileUrl} iv={fileIv} convKey={convKey} isMine={isMine}
                        upload={msg._upload ? { progress: msg._upload.progress, onCancel: () => onCancelUpload?.(msg) } : null}
                        failed={!!msg._failed} onRetry={() => onRetry?.(msg)}
                        onOpenImage={local => onImageTap(local, msg.id)} />
                      {caption && <div style={{ marginTop: 6, wordBreak: 'break-word' }}>{linkifyText(caption, isMine)}</div>}
                    </>
                  )
                })()
              ) : (() => {
                // A MeshPort payment request link renders as a live payment card.
                const payCode = codeFromLink(content)
                if (payCode) return <><MerchantPaymentCard code={payCode} isMine={isMine} text={content} />{content.startsWith('🧾 Bill') || content.startsWith('💸 Payment request') ? null : linkifyText(content, isMine)}</>
                // A MeshPort personal payment link (/pay/<user>, optional amount) → card.
                const personal = parsePersonalPayLink(content)
                if (personal) {
                  const leftover = content.replace(personal.url, '').replace(/[\s—–-]+$/, '').trim()
                  // Hide the default share text ("Pay me $5 USDC on MeshPort") — the card says it.
                  const rest = /^Pay me( \$[\d.,]+ USDC)? on MeshPort$/i.test(leftover) ? '' : leftover
                  return <><PayLinkCard link={personal} isMine={isMine} />{rest ? linkifyText(rest, isMine) : null}</>
                }
                return linkifyText(content, isMine)
              })()}
            </div>}
            {(isDeleted || !isImageMsg) && (
              <div className="relative flex items-center justify-end gap-1 mt-0.5">
                <p className={`text-[11px] ${isMine ? 'text-white/60' : 'text-text-secondary'}`}>{new Date(msg.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</p>
                {isMine && !isDeleted && <MessageTicks msg={msg} />}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
      {isMine && msg._failed && !msg._upload && (
        <div className="flex justify-end">
          <button type="button" onClick={e => { e.stopPropagation(); onRetry?.(msg) }}
            style={{ marginTop: 3, border: 'none', background: 'none', padding: '2px 4px', fontSize: 11.5, fontWeight: 600, color: '#ff8a7a', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>
            Not sent · Tap to retry
          </button>
        </div>
      )}
    </motion.div>
  )
})

// Long-press on a whole group selects all of it (shared by album + files).
function useGroupLongPress(msgs: any[], onSelectAll: (msgs: any[]) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  const begin = (x: number, y: number) => {
    start.current = { x, y }
    cancel()
    timer.current = setTimeout(() => { timer.current = null; try { navigator.vibrate?.(18) } catch { /* not supported */ } onSelectAll(msgs) }, 420)
  }
  return {
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; if (t) begin(t.clientX, t.clientY) },
    onTouchMove: (e: React.TouchEvent) => { const t = e.touches[0], s0 = start.current; if (t && s0 && (Math.abs(t.clientX - s0.x) > 8 || Math.abs(t.clientY - s0.y) > 8)) cancel() },
    onTouchEnd: cancel, onTouchCancel: cancel,
    onMouseDown: (e: React.MouseEvent) => begin(e.clientX, e.clientY), onMouseUp: cancel, onMouseLeave: cancel,
  }
}

/** Ticks for a group: failed / sending if any item is, else the last one's. */
const groupTickMsg = (msgs: any[]) => {
  const last = msgs[msgs.length - 1]
  return msgs.some(m => m._failed) ? { ...last, _failed: true } : msgs.some(m => String(m.id).startsWith('optimistic_')) ? { ...last, id: 'optimistic_' } : last
}

function GroupCaption({ msgs, isMine }: { msgs: any[]; isMine: boolean }) {
  const captions = msgs.map(m => parseMedia(plainTextOf(m.content) || m.content)?.caption || '').filter(Boolean)
  const last = msgs[msgs.length - 1]
  return (
    <div style={{ padding: captions.length ? '6px 8px 3px' : '0 8px 3px', wordBreak: 'break-word' }}>
      {captions.map((c, i) => <div key={i} className={`text-[15px] leading-snug ${isMine ? 'text-white' : 'text-text-primary'}`} style={{ marginTop: i ? 4 : 0 }}>{linkifyText(c, isMine)}</div>)}
      <div className="flex items-center justify-end gap-1 mt-0.5">
        <p className={`text-[11px] ${isMine ? 'text-white/60' : 'text-text-secondary'}`}>{new Date(last.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
        {isMine && <MessageTicks msg={groupTickMsg(msgs)} />}
      </div>
    </div>
  )
}

// ─── Album: 2+ photos sent together → one grid (2 side by side, 3 = one wide
// + two, 4+ = 2×2 with +N), caption underneath (WhatsApp) ────────────────────
const AlbumBubble = memo(function AlbumBubble({ msgs, isMine, convKey, onOpen, onSelectAll, selecting, onCancelUpload, onRetry }: {
  msgs: any[]; isMine: boolean; convKey: any
  onOpen: (msgId: string) => void
  onSelectAll: (msgs: any[]) => void
  selecting: boolean
  onCancelUpload: (msg: any) => void
  onRetry: (msg: any) => void
}) {
  const n = msgs.length
  const shown = msgs.slice(0, 4)
  const extra = n - 4
  const last = msgs[n - 1]
  const press = useGroupLongPress(msgs, onSelectAll)
  const hasCaption = msgs.some(m => !!parseMedia(plainTextOf(m.content) || m.content)?.caption)
  const cellHeight = (i: number) => n === 2 ? 170 : n === 3 ? (i === 0 ? 150 : 118) : 126
  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} mt-1`} {...press}
      style={{ WebkitUserSelect: 'none', userSelect: 'none' }}>
      <div className={`relative shadow-md ${isMine ? 'bg-brand' : 'bg-surface border border-border'}`}
        style={{ width: 262, padding: 3, borderRadius: isMine ? '18px 4px 18px 18px' : '4px 18px 18px 18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 3, borderRadius: 15, overflow: 'hidden' }}>
          {shown.map((m, i) => {
            const md = parseMedia(plainTextOf(m.content) || m.content)
            const span = n === 3 && i === 0 ? { gridColumn: '1 / span 2' } : {}
            if (!md) return <div key={m.id} style={{ height: cellHeight(i), ...span }} />
            const moreHere = i === 3 && extra > 0
            return (
              <div key={m.id} style={{ position: 'relative', height: cellHeight(i), ...span }}>
                <ChatImage url={md.url} iv={md.iv} convKey={convKey} square radius="3px"
                  upload={m._upload ? { progress: m._upload.progress, onCancel: () => onCancelUpload(m) } : null}
                  failed={!!m._failed} onRetry={() => onRetry(m)}
                  onTap={() => { if (!selecting) onOpen(m.id) }} />
                {moreHere && (
                  <div onClick={() => { if (!selecting) onOpen(m.id) }}
                    style={{ position: 'absolute', inset: 0, borderRadius: 3, background: 'rgba(0,0,0,0.5)', color: '#fff', fontSize: 26, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>+{extra}</div>
                )}
              </div>
            )
          })}
        </div>
        {hasCaption ? <GroupCaption msgs={msgs} isMine={isMine} /> : (
          <div style={{ position: 'absolute', bottom: 8, right: 10, display: 'flex', alignItems: 'center', gap: 3, background: 'rgba(0,0,0,0.45)', borderRadius: 10, padding: '2px 6px', pointerEvents: 'none' }}>
            <span style={{ fontSize: 11, color: '#fff' }}>{new Date(last.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            {isMine && <MessageTicks msg={groupTickMsg(msgs)} onMedia />}
          </div>
        )}
      </div>
    </div>
  )
})

// ─── Files / documents sent together → one bubble, one row each ────────────
const FileGroupBubble = memo(function FileGroupBubble({ msgs, isMine, convKey, onOpenImage, onSelectAll, onCancelUpload, onRetry }: {
  msgs: any[]; isMine: boolean; convKey: any
  onOpenImage: (localUrl: string, msgId?: string) => void
  onSelectAll: (msgs: any[]) => void
  onCancelUpload: (msg: any) => void
  onRetry: (msg: any) => void
}) {
  const press = useGroupLongPress(msgs, onSelectAll)
  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} mt-1`} {...press}
      style={{ WebkitUserSelect: 'none', userSelect: 'none' }}>
      <div className={`relative shadow-md max-w-[78%] w-fit ${isMine ? 'bg-brand rounded-[18px] rounded-br-[4px]' : 'bg-surface border border-border rounded-[18px] rounded-bl-[4px]'}`}
        style={{ padding: '6px 6px 2px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {msgs.map(m => {
            const md = parseMedia(plainTextOf(m.content) || m.content)
            if (!md) return null
            return (
              <div key={m.id} className={`text-[15px] ${isMine ? 'text-white' : 'text-text-primary'}`} style={{ padding: '2px 4px' }}>
                <ChatFile name={md.name} url={md.url} iv={md.iv} convKey={convKey} isMine={isMine}
                  upload={m._upload ? { progress: m._upload.progress, onCancel: () => onCancelUpload(m) } : null}
                  failed={!!m._failed} onRetry={() => onRetry(m)}
                  onOpenImage={local => onOpenImage(local, m.id)} />
              </div>
            )
          })}
        </div>
        <GroupCaption msgs={msgs} isMine={isMine} />
      </div>
    </div>
  )
})

// ─── Reply quote body (bubble + composer bar): name, then what it was —
// 📷 Photo / 📄 file name / text — with a thumbnail on the right (WhatsApp) ──
function QuoteBody({ quoted, name, nameColor, textColor, convKey }: {
  quoted: any | null; name: string; nameColor: string; textColor: string; convKey: any
}) {
  const plain = quoted && quoted.content !== '[deleted]' ? (plainTextOf(quoted.content) || '') : ''
  const md = plain ? parseMedia(plain) : null
  const icon = (d: string) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={d} /></svg>
  const line = !quoted ? 'Original message not loaded'
    : quoted.content === '[deleted]' ? 'This message was deleted'
    : md ? (md.caption || (md.kind === 'image' ? 'Photo' : md.name))
    : messagePreview(quoted.content)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: nameColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: textColor, minWidth: 0 }}>
          {md?.kind === 'image' && icon('M4 7h3l2-3h6l2 3h3v13H4zM12 17a4 4 0 100-8 4 4 0 000 8z')}
          {md?.kind === 'file' && icon('M14 3H6v18h12V7zM14 3v4h4')}
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</span>
        </span>
      </div>
      {md?.kind === 'image' && <QuoteThumb url={md.url} iv={md.iv} convKey={convKey} />}
      {md?.kind === 'file' && <FileTypeTile name={md.name} />}
    </div>
  )
}

// ─── Chat wallpaper — WhatsApp/Telegram-style tiled doodle background ──────────
// Payments-app take on the pattern: crypto coin, food and merchant line icons,
// scattered and rotated, tinted with the app's own brand color so it reads as
// MeshPort-branded rather than generic gray doodles. Real inline SVG (not a
// CSS data-URI background-image) so it can reference var(--brand) directly —
// one pattern definition, automatically correct in both light and dark mode,
// no separate theme-specific assets to keep in sync. useId() keeps the
// <pattern> id collision-free if this ever mounts more than once (e.g. a
// future split view rendering two conversations at once).
function ChatWallpaper() {
  const uid = useId()
  const patternId = `chat-wallpaper-${uid}`
  const c = 'var(--brand)'
  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      <defs>
        <pattern id={patternId} width="340" height="340" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
          {/* Coin ($) */}
          <g transform="translate(28,32)" opacity="0.16">
            <circle r="13" stroke={c} strokeWidth="1.6" fill="none" />
            <path d="M0 -7v14M-4 -3.4c0-2 1.8-3.1 4-3.1s4 1.1 4 2.9-1.8 2.7-4 2.7-4 1-4 2.9 1.8 3.1 4 3.1 4-1.1 4-3.1" stroke={c} strokeWidth="1.3" strokeLinecap="round" fill="none" />
          </g>
          {/* Coffee cup */}
          <g transform="translate(140,44)" opacity="0.16">
            <path d="M-9 -6h16v9a8 8 0 01-16 0v-9z" stroke={c} strokeWidth="1.4" strokeLinejoin="round" fill="none" />
            <path d="M7 -3c4 0 5 2 5 4s-1 4-5 4" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M-5 -10c0 1.5 2 1.5 2 3M0 -10c0 1.5 2 1.5 2 3" stroke={c} strokeWidth="1.1" strokeLinecap="round" fill="none" />
          </g>
          {/* Bitcoin */}
          <g transform="translate(252,28)" opacity="0.16">
            <circle r="13" stroke={c} strokeWidth="1.5" fill="none" />
            <text x="0" y="5.5" fontSize="15" textAnchor="middle" fill={c} fontFamily="sans-serif" fontWeight="700">₿</text>
          </g>
          {/* Ethereum */}
          <g transform="translate(318,96)" opacity="0.16">
            <circle r="13" stroke={c} strokeWidth="1.5" fill="none" />
            <text x="0" y="5.5" fontSize="15" textAnchor="middle" fill={c} fontFamily="sans-serif" fontWeight="700">Ξ</text>
          </g>
          {/* Shopping bag (merchant) */}
          <g transform="translate(50,136)" opacity="0.16">
            <path d="M-9 -4h18l-2 16h-14l-2-16z" stroke={c} strokeWidth="1.4" strokeLinejoin="round" fill="none" />
            <path d="M-5 -4v-3a5 5 0 0110 0v3" stroke={c} strokeWidth="1.3" fill="none" />
          </g>
          {/* Globe coin (multichain) */}
          <g transform="translate(174,116)" opacity="0.16">
            <circle r="13" stroke={c} strokeWidth="1.5" fill="none" />
            <path d="M-13 0h26M0 -13c3.5 3.5 5.3 8 5.3 13s-1.8 9.5-5.3 13c-3.5-3.5-5.3-8-5.3-13s1.8-9.5 5.3-13z" stroke={c} strokeWidth="1.1" fill="none" />
          </g>
          {/* Shopping cart (grocery) */}
          <g transform="translate(282,150)" opacity="0.16">
            <path d="M-10 -8h3l2 12h11l3-9h-14" stroke={c} strokeWidth="1.3" fill="none" strokeLinejoin="round" />
            <circle cx="-3" cy="9" r="1.6" fill={c} />
            <circle cx="7" cy="9" r="1.6" fill={c} />
          </g>
          {/* Chain link (blockchain) */}
          <g transform="translate(30,228)" opacity="0.16">
            <rect x="-11" y="-4" width="12" height="8" rx="4" transform="rotate(-25)" stroke={c} strokeWidth="1.3" fill="none" />
            <rect x="-1" y="-4" width="12" height="8" rx="4" transform="rotate(-25)" stroke={c} strokeWidth="1.3" fill="none" />
          </g>
          {/* Pizza slice (food) */}
          <g transform="translate(112,208)" opacity="0.16">
            <path d="M-10 8L0 -10l10 8c-5 5-15 5-20 0z" stroke={c} strokeWidth="1.4" strokeLinejoin="round" fill="none" />
            <circle cx="-2" cy="2" r="1.1" fill={c} />
            <circle cx="3" cy="-1" r="1.1" fill={c} />
          </g>
          {/* Burger (food) */}
          <g transform="translate(224,224)" opacity="0.16">
            <path d="M-11 -4a11 5 0 0122 0z" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M-11 1h22" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
            <path d="M-11 5h22" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
            <path d="M-9 9a9 3 0 0018 0z" stroke={c} strokeWidth="1.3" fill="none" />
          </g>
          {/* Wallet */}
          <g transform="translate(306,258)" opacity="0.16">
            <rect x="-12" y="-8" width="24" height="16" rx="3" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M4 -8v4h8" stroke={c} strokeWidth="1.2" fill="none" />
            <circle cx="6" cy="0" r="1.6" fill={c} />
          </g>
          {/* Apple (grocery) */}
          <g transform="translate(76,296)" opacity="0.16">
            <path d="M-6 -2c-4 3-3 10 2 12c2 1 4 1 4 1s2 0 4-1c5-2 6-9 2-12c-2-1.5-4 0-6 0c-2 0-4-1.5-6 0z" stroke={c} strokeWidth="1.2" fill="none" />
            <path d="M0 -2v-4M0 -6c1-2 3-2 4-1" stroke={c} strokeWidth="1.1" strokeLinecap="round" fill="none" />
          </g>
          {/* Tree */}
          <g transform="translate(186,308)" opacity="0.16">
            <circle cy="-4" r="8" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M0 4v8" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
          </g>
          {/* Storefront (merchant) */}
          <g transform="translate(276,328)" opacity="0.16">
            <path d="M-11 -6l2-5h18l2 5" stroke={c} strokeWidth="1.3" strokeLinejoin="round" fill="none" />
            <path d="M-12 -6a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0" stroke={c} strokeWidth="1.2" fill="none" />
            <path d="M-9 -3v11h18v-11" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M-3 8v-6h6v6" stroke={c} strokeWidth="1.2" fill="none" />
          </g>
          {/* Bank */}
          <g transform="translate(200,66)" opacity="0.16">
            <path d="M-11 -7l11-6 11 6" stroke={c} strokeWidth="1.3" strokeLinejoin="round" fill="none" />
            <path d="M-11 -7h22M-9 -4v10M-3 -4v10M3 -4v10M9 -4v10" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
            <path d="M-12 6h24" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
          </g>
          {/* Laptop / code */}
          <g transform="translate(14,168)" opacity="0.16">
            <rect x="-12" y="-8" width="24" height="14" rx="1.5" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M-15 9h30l-2 3h-26z" stroke={c} strokeWidth="1.2" strokeLinejoin="round" fill="none" />
            <path d="M-6 -3l-3 3 3 3M6 -3l3 3-3 3" stroke={c} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </g>
          {/* Bar chart */}
          <g transform="translate(258,196)" opacity="0.16">
            <path d="M-10 8V-2M-2 8V-8M6 8V2" stroke={c} strokeWidth="2" strokeLinecap="round" />
            <path d="M-12 8h24" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
          </g>
          {/* Credit card */}
          <g transform="translate(140,272)" opacity="0.16">
            <rect x="-13" y="-8" width="26" height="16" rx="2.5" stroke={c} strokeWidth="1.3" fill="none" />
            <path d="M-13 -3h26" stroke={c} strokeWidth="1.3" />
            <path d="M-9 4h6" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
          </g>
          {/* Gear / settings */}
          <g transform="translate(328,218)" opacity="0.16">
            <circle r="6" stroke={c} strokeWidth="1.3" fill="none" />
            <circle r="1.6" fill={c} />
            <path d="M0 -10v3M0 7v3M-10 0h3M7 0h3M-7 -7l2 2M5 5l2 2M-7 7l2-2M5 -5l2-2" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
          </g>
          {/* Target */}
          <g transform="translate(58,52)" opacity="0.16">
            <circle r="9" stroke={c} strokeWidth="1.2" fill="none" />
            <circle r="5" stroke={c} strokeWidth="1.2" fill="none" />
            <circle r="1.4" fill={c} />
          </g>
          {/* Wifi / connectivity */}
          <g transform="translate(300,10)" opacity="0.16">
            <path d="M-9 -1a13 13 0 0118 0M-5 3a7 7 0 0110 0" stroke={c} strokeWidth="1.2" fill="none" strokeLinecap="round" />
            <circle cy="6" r="1.4" fill={c} />
          </g>
          {/* WEB3 label */}
          <text x="96" y="152" fontSize="11" fontWeight="700" letterSpacing="1" fill={c} opacity="0.16" fontFamily="sans-serif">WEB3</text>
          {/* DeFi label */}
          <text x="222" y="102" fontSize="11" fontWeight="700" fill={c} opacity="0.16" fontFamily="sans-serif">DeFi</text>
          {/* DAO label */}
          <text x="8" y="272" fontSize="10.5" fontWeight="700" letterSpacing="1" fill={c} opacity="0.16" fontFamily="sans-serif">DAO</text>
          {/* NFT hex badge */}
          <g transform="translate(150,336)" opacity="0.16">
            <path d="M0 -11l9.5 5.5v11L0 11l-9.5 -5.5v-11z" stroke={c} strokeWidth="1.2" fill="none" strokeLinejoin="round" />
            <text x="0" y="4" fontSize="8" textAnchor="middle" fill={c} fontFamily="sans-serif" fontWeight="700">NFT</text>
          </g>
          {/* Scattered tiny accents — small crosses/dots for texture, matching
              the reference image's busier confetti-like scattering between
              the main icons. */}
          <g stroke={c} strokeWidth="1.1" strokeLinecap="round" opacity="0.13">
            <path d="M100 14v8M96 18h8" />
            <path d="M232 138v8M228 142h8" />
            <path d="M20 98v8M16 102h8" />
            <path d="M162 198v8M158 202h8" />
            <path d="M52 246v8M48 250h8" />
            <path d="M282 296v8M278 300h8" />
          </g>
          <g fill={c} opacity="0.13">
            <circle cx="188" cy="18" r="1.6" />
            <circle cx="8" cy="140" r="1.6" />
            <circle cx="250" cy="256" r="1.6" />
            <circle cx="108" cy="256" r="1.6" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}

// ─── Chat Conversation ─────────────────────────────────────────────────────────
export function ChatConversationPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore(s => s.user)
  const privateKey = useAuthStore(s => s.privateKey)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const { balance, setBalance } = useWalletStore()
  // Desktop users type on a physical keyboard — the pay-flow's inline
  // tap-grid below is a mobile-only affordance.
  const isDesktop = useMediaQuery('(min-width: 980px)')

  const _initMsgs = _cachedMessages[id || ''] || []
  const _initFirstUnreadId = user?.id ? (_initMsgs.find(m => !m.is_read && m.sender_id !== user.id)?.id || null) : null
  // Cache-first init for the header identity, same reasoning as messages
  // below: _cachedConversations (populated the moment the Chats list loads,
  // well before this component ever mounts) already carries each
  // conversation's full other_user object — avatar, username, display
  // name, all of it. Previously otherUser always started as null and only
  // got set inside the async setupConversation() effect, which is exactly
  // why the avatar/name/header visibly popped in after a delay instead of
  // being there from the very first paint, even though the data was
  // sitting in memory the whole time.
  const _findCachedOtherUser = () => {
    if (!id) return null
    if (id.startsWith('new_')) return _cachedOtherUser[id.replace('new_', '')] || null
    return _cachedConversations.find(c => c.id === id)?.other_user || _cachedOtherUser[id] || null
  }
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const deleted = deletedForMe()
    return deleted.size ? _initMsgs.filter(m => !deleted.has(m.id)) : _initMsgs
  })
  const [otherUser, setOtherUser] = useState<any>(_findCachedOtherUser)
  // E2E encryption — the AES key shared with `otherUser`, derived from their
  // public key + this device's own private key (see chatCrypto.ts). Stays
  // null (meaning "send/display as plaintext") until otherUser is known AND
  // both sides have a chat_public_key on file — see getConversationKey's
  // own comment on why that's a safe, non-blocking fallback rather than an
  // error state.
  const [convKey, setConvKey] = useState<any>(null)
  // Which conversation partner convKey was resolved for (null key is a valid
  // "no E2E yet" answer, so readiness is tracked separately).
  const [convKeyFor, setConvKeyFor] = useState<string | null>(null)
  // Reactive, not getState() — this used to read walletAddress once via
  // getState() with only otherUser?.id in the dependency array. If the chat
  // page opened before the wallet address had finished loading (a real race
  // on cold app start / fresh login), this bailed to convKey=null and never
  // ran again for this conversation once the address DID become available a
  // moment later, since walletAddress wasn't a dependency — every message
  // was then stuck showing the "unable to decrypt on this device" fallback
  // for the rest of that chat session, even though the key was derivable
  // moments after the page opened.
  const walletAddress = useAuthStore((s) => s.walletAddress)
  // The wallet key can unlock after the chat opens (passcode, restore) —
  // the conversation key is derived from it, so derive again then.
  const walletKeyReady = useAuthStore((s) => !!s.privateKey)
  useEffect(() => {
    if (!otherUser?.id || !walletAddress) { setConvKey(null); return }
    let cancelled = false
    import('@/lib/chatCrypto').then(({ getConversationKey }) =>
      getConversationKey(walletAddress, otherUser.id).then(k => { if (!cancelled) { setConvKey(k); setConvKeyFor(otherUser.id) } })
    )
    return () => { cancelled = true }
  }, [otherUser?.id, walletAddress, walletKeyReady])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const _setConvId = (id: string | null) => { conversationIdRef.current = id; setConversationId(id) }
  // A merchant's "Send in chat" opens the conversation with the payment
  // request pre-typed (they still tap Send themselves).
  const [messageText, setMessageText] = useState(() => {
    const draft = (location.state as any)?.draft
    return typeof draft === 'string' ? draft.slice(0, 2000) : ''
  })
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showAttach, setShowAttach] = useState(false)
  // Merchants: "Bill" in the attach menu — build a bill and send it here.
  const merchant = useMerchant()
  const [showBill, setShowBill] = useState(false)
  const [deleteMsg, setDeleteMsg] = useState<any | null>(null)
  const [deleting, setDeleting] = useState(false)
  const msgLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // WhatsApp-style selection: long-press selects, taps add/remove, the header
  // becomes the action bar. id → the message (with isMine).
  const [selected, setSelected] = useState<Record<string, any>>({})
  const selectedList = Object.values(selected).sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  const selecting = selectedList.length > 0
  const justLongPressedRef = useRef(0)
  // Delete dialog (one or more messages), forward sheet, message info, and
  // the "Deleted for you · UNDO" bar.
  const [deleteTargets, setDeleteTargets] = useState<any[] | null>(null)
  const [forwardMsgs, setForwardMsgs] = useState<any[] | null>(null)
  const [infoMsg, setInfoMsg] = useState<any | null>(null)
  const [undoDeleted, setUndoDeleted] = useState<{ msgs: any[]; timer: ReturnType<typeof setTimeout> } | null>(null)
  // Swipe-to-reply: the message being replied to (shown above the composer).
  const [replyTo, setReplyTo] = useState<any | null>(null)
  // Photo picking: which attach option opened the picker, the send-preview
  // screen, and the full-screen viewer (opened on a message).
  const pickModeRef = useRef<'image' | 'document' | 'file'>('file')
  const [previewItems, setPreviewItems] = useState<PreviewItem[] | null>(null)
  const [viewerStartId, setViewerStartId] = useState<string | null>(null)
  const latestMessagesRef = useRef<ChatMessage[]>([])
  latestMessagesRef.current = messages
  const getMsgById = useCallback((mid: string) => latestMessagesRef.current.find(m => m.id === mid) ?? null, [])
  const startReply = useCallback((msg: any) => {
    setReplyTo(msg)
    requestAnimationFrame(() => messageInputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const jumpToMessage = useCallback((mid: string) => {
    const el = messageRefs.current[mid]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    try {
      el.animate([{ backgroundColor: 'color-mix(in srgb, var(--link) 28%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out', delay: 250 })
    } catch { /* no Web Animations */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  // The first unread message for THIS open of the conversation — set once,
  // right when messages are fetched (using their real is_read/sender_id at
  // that moment, before markRead() has a chance to flip them server-side).
  // Cleared after its one-time use so it never affects later scroll
  // behavior (sending a message, a new message arriving live, etc. should
  // always still go straight to the bottom — only the very first landing
  // spot on open should target unread messages, matching WhatsApp/Telegram).
  const firstUnreadIdRef = useRef<string | null>(_initFirstUnreadId)
  // Timestamp-based fallback anchor — the dedup pass below can legitimately
  // drop the exact message firstUnreadIdRef points to (echo payment rows
  // the other side shouldn't see, content-based duplicate detection, etc),
  // which would silently mean the "Unread Messages" divider never renders
  // at all, since nothing in the final list would ever match that exact id.
  // Comparing by created_at against whatever DID survive dedup means the
  // divider still lands in the right place either way.
  const _initFirstUnreadAt = _initFirstUnreadId ? (_initMsgs.find(m => m.id === _initFirstUnreadId)?.created_at || null) : null
  const firstUnreadAtRef = useRef<string | null>(_initFirstUnreadAt)
  // Only show the divider once there are genuinely a few unread messages to
  // review — a single unread message doesn't need a "catch up on this"
  // banner, same as WhatsApp not bothering for just one either.
  const _initUnreadCount = user?.id ? _initMsgs.filter(m => !m.is_read && m.sender_id !== user.id).length : 0
  const unreadCountRef = useRef<number>(_initUnreadCount)
  // Cross-check against the Chats list's own unread_count, which is kept
  // genuinely current by the live cache-invalidation fixes elsewhere in
  // this file (BottomNav's realtime listener busts it on every new
  // message, ChatListPage always refetches on mount). If the list says
  // there ARE unread messages here but this messages cache says zero,
  // this specific cache is stale about read status — its "confidently
  // zero unread, safe to scroll to bottom" conclusion can't be trusted.
  // Without this check, that wrong-but-confident guess would render
  // immediately (scrolled to bottom), then get corrected a moment later
  // once the fresh fetch reveals the real unread messages — a visible
  // jump/flicker right as the conversation opens, which is exactly what
  // was being reported.
  const _cachedConvUnread = _cachedConversations.find(c => c.id === id)?.unread_count ?? 0
  const _cacheUnreadUncertain = _initUnreadCount === 0 && _cachedConvUnread > 0
  // Controls the divider's exit animation — stays visible for a beat after
  // opening so it's actually seen, then fades out smoothly once the
  // messages it's marking are genuinely read (not the instant data loads,
  // which is what "is_read" flipping alone would otherwise imply).
  const [dividerDismissed, setDividerDismissed] = useState(false)
  // Guards against double-positioning: both the cache layout effect and the
  // fresh-fetch finally-block can each try to set the initial scroll
  // position, but only the first one to actually run should do anything —
  // otherwise a fresh fetch resolving shortly after the cached content was
  // already correctly positioned would cause a second, unwanted jump.
  const hasPositionedInitialScrollRef = useRef(false)

  // Filter out messages deleted-for-me (stored in localStorage)
  const filterDeleted = (msgs: ChatMessage[]) => {
    const deleted = deletedForMe()
    return deleted.size ? msgs.filter(m => !deleted.has(m.id)) : msgs
  }
  const isKeyboardOpen = useRef(false)
  // Cache-aware, same reasoning as `messages` above: if there's already
  // cached content to show for this conversation, reveal it immediately —
  // previously this always started false and only flipped true inside
  // scrollToBottom() after setupConversation()'s async fetch resolved
  // (plus an 80ms delay on top), which meant the message area sat
  // invisible on every single open regardless of whether the data was
  // already sitting in cache and ready to render right now.
  const [messagesReady, setMessagesReady] = useState(() => _initMsgs.length > 0 && !_cacheUnreadUncertain)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMoreHistory, setHasMoreHistory] = useState(true)

  // Positions the view on conversation open — lands on the first unread
  // message (matching WhatsApp/Telegram) if one exists, otherwise the
  // latest message. Runs SYNCHRONOUSLY before the browser paints —
  // critical specifically because messagesReady can start `true` already
  // (cached messages render instantly, see above). Without this, content
  // was visible on the very first paint but not yet positioned — the
  // actual scroll only happened later via a requestAnimationFrame +
  // setTimeout chain — so the first thing anyone saw was the TOP of the
  // cached conversation, followed by a visible jump a beat later.
  // useLayoutEffect runs after the DOM updates but before the browser
  // paints anything, so this repositions before there's ever a frame
  // rendered at the wrong spot — same "position first, then let it be
  // seen" idea the rest of this file already uses.
  useLayoutEffect(() => {
    // Refs only take their initial value on the component's very first
    // render — switching conversations (same component instance, just a
    // different :id param) doesn't re-run that initializer, so without
    // this explicit sync these would silently keep showing the PREVIOUS
    // conversation's values. _initMsgs/_initFirstUnreadId are recomputed
    // fresh on every render using the current id, so this is always correct.
    firstUnreadIdRef.current = _initFirstUnreadId
    firstUnreadAtRef.current = _initFirstUnreadAt
    unreadCountRef.current = _initUnreadCount
    hasPositionedInitialScrollRef.current = false

    const el = messagesAreaRef.current
    if (el && _initMsgs.length > 0) {
      const target = firstUnreadIdRef.current && document.getElementById(`msg-${firstUnreadIdRef.current}`)
      if (target && unreadCountRef.current > 0) {
        // Position the divider with a small, FIXED amount of read-message
        // context above it — not flush at the very top, not scrolled past
        // it. This one rule is deliberately the same regardless of unread
        // count: with many unread messages, that small buffer is a tiny
        // fraction of the viewport, so the divider ends up effectively near
        // the top and the rest of the screen is unread content to read
        // downward through. With few unread messages, the exact same rule
        // shows the divider with a little prior context above it and the
        // (short) remainder of unread content below. Same math either way
        // — no branching on count needed, which is exactly what "identical
        // regardless of whether there are 2 or 100 unread" means.
        //
        // getBoundingClientRect, not offsetTop — offsetTop is relative to
        // each element's OWN nearest position:relative ancestor, which
        // isn't guaranteed to be the same for the target message and the
        // scrollable container (message bubbles have their own internal
        // position:relative wrappers), so subtracting two offsetTop values
        // silently produces a wrong number. getBoundingClientRect is always
        // viewport-relative, so this comparison is correct regardless of
        // DOM nesting.
        const containerTop = el.getBoundingClientRect().top
        const targetTop = target.getBoundingClientRect().top
        const CONTEXT_ABOVE_DIVIDER_PX = 72 // roughly one short message bubble's worth of "peek"
        el.scrollTop = Math.max(0, el.scrollTop + (targetTop - containerTop) - CONTEXT_ABOVE_DIVIDER_PX)
        // This positioning used CONFIRMED unread data (found a real target),
        // so it's final — no need for positionInitialView to redo it once
        // the fresh fetch resolves.
        hasPositionedInitialScrollRef.current = true
      } else {
        // No unread messages in the CACHED snapshot — open at the bottom
        // for now. Deliberately NOT marking this as final: the cache can be
        // stale (e.g. everything was read last visit, but new messages have
        // arrived since then that this cache doesn't know about yet). If
        // that's the case, the upcoming fresh fetch will reveal a real
        // unread count, and positionInitialView needs to actually be
        // allowed to act on it instead of finding this flag already set
        // and skipping — which is exactly what was leaving new messages
        // sitting at the bottom, behind the composer, instead of properly
        // showing the divider.
        el.scrollTop = el.scrollHeight
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Like WhatsApp: the "N unread messages" line stays while you're in the
  // chat (so you can find where you left off) and goes once you reply.
  // Resets fresh on every conversation switch.
  useEffect(() => { setDividerDismissed(false) }, [id])

  // ── In-conversation message search ──────────────────────────────────────
  const [msgSearchOpen, setMsgSearchOpen] = useState(false)
  const [msgSearchQuery, setMsgSearchQuery] = useState('')
  const [msgSearchIndex, setMsgSearchIndex] = useState(0)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    setMsgSearchIndex(0)
  }, [msgSearchQuery])
  const statsCardRef = useRef<HTMLDivElement>(null)
  const conversationIdRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Fullscreen media viewer ───────────────────────────────────────────────
  const [viewerSrc, setViewerSrc] = useState<string | null>(null)
  const [viewerType, setViewerType] = useState<'image' | 'file'>('image')

  // ── In-chat payment modal state ──────────────────────────────────────────
  const [payStep, setPayStep] = useState<'closed' | 'form' | 'confirm' | 'processing' | 'success'>('closed')
  const payStartRef = useRef(0)
  const [elapsedSeconds, setElapsedSeconds] = useState('0.00')
  // Whether THIS payment's passcode came from a biometric check vs typed
  // manually — same purpose/mechanism as PaySendPage's own paidViaBiometric,
  // see PinKeypad.tsx's own comment on why onComplete's second argument
  // exists at all.
  const [payViaBiometric, setPayViaBiometric] = useState(false)

  // ── Full-screen brand flash + traveling checkmark, same pattern as
  // PaySendPage's success screen ───────────────────────────────────────────
  // 'flash' -> full-screen brand takeover with a big checkmark, holds
  // briefly -> checkmark travels (measured position, not Framer layout/
  // layoutId) into this modal's own checkmark spot -> 'collapsed' reveals
  // the rest of the success content with a staggered drop-in. See
  // PaySendPage.tsx's own extensive comments on why this exact technique
  // (plain getBoundingClientRect + transform) is what's used, not the
  // fancier Framer APIs tried first there.
  const [paySuccessPhase, setPaySuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  useEffect(() => {
    if (payStep !== 'success') { setPaySuccessPhase('flash'); return }
    const t = setTimeout(() => setPaySuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [payStep])

  // Gates FlashAuthIcon's own bio->check swap (see that component's own
  // comment) — flips true only once the white circle below has actually
  // finished its spring entrance (onAnimationComplete), not on a guessed
  // timer. Reset alongside paySuccessPhase so a repeat chat payment gets
  // a fresh flash instead of starting pre-armed.
  const [payFlashCircleReady, setPayFlashCircleReady] = useState(false)
  useEffect(() => { if (paySuccessPhase === 'flash') setPayFlashCircleReady(false) }, [paySuccessPhase])

  const payFlashCheckRef = useRef<HTMLDivElement>(null)
  const paySuccessCheckRef = useRef<HTMLDivElement>(null)
  const lastPayFlashRectRef = useRef<DOMRect | null>(null)
  const [payTravelRect, setPayTravelRect] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [payTravelDone, setPayTravelDone] = useState(false)

  useLayoutEffect(() => {
    if (paySuccessPhase === 'flash' && payFlashCheckRef.current) {
      lastPayFlashRectRef.current = payFlashCheckRef.current.getBoundingClientRect()
    }
  })

  useEffect(() => {
    if (paySuccessPhase !== 'collapsed') { setPayTravelDone(false); setPayTravelRect(null); return }
    const from = lastPayFlashRectRef.current
    requestAnimationFrame(() => {
      const to = paySuccessCheckRef.current?.getBoundingClientRect()
      if (from && to) {
        setPayTravelRect({ from, to })
        const t = setTimeout(() => setPayTravelDone(true), 520)
        return () => clearTimeout(t)
      } else {
        setPayTravelDone(true)
      }
    })
  }, [paySuccessPhase])
  const chatPayInFlightRef = useRef(false)
  // RESILIENCE FIX (2026-09-17): same vulnerability as PaySendPage.tsx's
  // own idempotencyKeyRef (see its full comment there) — ChatPay never
  // passed an idempotencyKey at all, so arcService.ts minted a brand new
  // random one on every single call, including retries. On a bad
  // connection, retrying after a dropped response could silently create a
  // second real transaction. Keyed on the actual payment parameters, same
  // as PaySendPage: identical recipient+amount+token reuses the same key
  // across retries; any actual change computes a fresh one automatically.
  const chatPayIdempotencyKeyRef = useRef<{ signature: string; key: string } | null>(null)
  const [payAmount, setPayAmount] = useState('')

  // ── Hold-to-repeat delete for ChatPay's own keypad ──────────────────────
  // Same fix as the shared AmountKeypad component: holding the delete key
  // now keeps deleting on its own instead of needing a tap per character.
  // setPayAmount's functional-update form (v => ...) always sees the latest
  // state regardless of closure timing, so no extra "live value" ref is
  // needed here the way the shared component required for its controlled
  // `value` prop.
  const payDeleteTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const payDeleteIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clearPayDeleteTimers = () => {
    if (payDeleteTimeoutRef.current)  { clearTimeout(payDeleteTimeoutRef.current);  payDeleteTimeoutRef.current = null }
    if (payDeleteIntervalRef.current) { clearInterval(payDeleteIntervalRef.current); payDeleteIntervalRef.current = null }
  }
  const startPayDeleteHold = () => {
    clearPayDeleteTimers()
    // First character is already removed by the button's own onClick — this
    // just arms the repeat-on-hold for presses that continue past a beat,
    // so a quick tap still behaves exactly like a single delete.
    payDeleteTimeoutRef.current = setTimeout(() => {
      payDeleteIntervalRef.current = setInterval(() => { setPayAmount(v => v.slice(0, -1)); setPayError('') }, 70)
    }, 350)
  }
  const stopPayDeleteHold = () => clearPayDeleteTimers()
  useEffect(() => clearPayDeleteTimers, [])

  // ── Pre-warm heavy chunks on ChatConversationPage mount ──────────────────
  // arcService (viem) + payIntentService (Supabase edge call) + security
  // (bcrypt/argon) are the three largest dynamic imports on the ChatPay
  // critical path. Cold-parsing them on first use costs 200–600ms each,
  // landing squarely on the PIN-submit → broadcast leg and making every
  // ChatPay feel slow. Importing them the instant the conversation page
  // mounts (before the user has even opened the pay sheet or typed a PIN)
  // means V8 has already parsed and cached all three by the time they're
  // actually needed — the broadcast path becomes purely network-bound
  // rather than network + module-parse bound.
  // Fire-and-forget: errors silently ignored, pure warm-ups.
  useEffect(() => {
    import('@/lib/arcService').catch(() => {})
    import('@/lib/payIntentService').catch(() => {})
    import('@/lib/security').catch(() => {})
  }, [])

  const [showAmountPad, setShowAmountPad] = useState(false)
  const [payToken, setPayToken] = useState<'USDC' | 'EURC' | 'cirBTC'>('USDC')
  // Set when the pay sheet was opened from a bill / payment-request card:
  // amount + token are fixed and the payment is linked to that bill.
  // number = the order number (ORD-…); older requests fall back to the code.
  const [billPay, setBillPay] = useState<{ code: string; number: string; orderNumber: string | null; amount: number } | null>(null)
  // Set when the pay sheet was opened from a personal payment link card; an
  // amount in the link is fixed (the requester set it).
  const [linkPay, setLinkPay] = useState<{ username: string; amount: string | null } | null>(null)
  const payLocked = !!billPay || !!linkPay?.amount
  // BUG FIX (2026-09-17): the confirm sheet used to hardcode "Network Fee:
  // Free" as a static label — never computed anything, just always showed
  // that regardless of token. Every send has a real, if tiny, gas cost
  // (see arcService.ts's own estimateTransferFee, same helper PaySendPage.tsx
  // uses). Mirrors PaySendPage's own pattern: token-aware (EURC/cirBTC are
  // ERC-20 transfer() calls with a different, higher gas-unit assumption
  // than a native USDC send — see estimateTransferFee's own comment).
  const [payEstimatedFee, setPayEstimatedFee] = useState(0)
  useEffect(() => {
    let cancelled = false
    import('@/lib/arcService').then(({ estimateTransferFee }) => {
      estimateTransferFee(0, payToken !== 'USDC').then(fee => { if (!cancelled) setPayEstimatedFee(fee) })
    })
    return () => { cancelled = true }
  }, [payToken])
  const chatSettingsMap = useSettingsStore((s) => s.settings)
  const [eurcBalance, setEurcBalance] = useState(0)
  const [cirbtcBalance, setCirbtcBalance] = useState<number | null>(null)
  // Gated on cirbtcBalance !== null, same as PaySendPage's own token picker
  // -- cirBTC only appears once its balance has actually loaded (handlePay
  // kicks that fetch off when the sheet opens), so a failed/slow balance
  // read never shows a token no one can confirm they hold.
  const payTokenList = (['USDC', 'EURC'] as ChatPayToken[]).concat(cirbtcBalance !== null ? ['cirBTC' as ChatPayToken] : [])
    .filter(t => isCoinEnabled(chatSettingsMap, t))
  const payTokenBalanceOf = (t: ChatPayToken) =>
    t === 'USDC' ? balance : t === 'EURC' ? eurcBalance : (cirbtcBalance ?? 0)
  const [payNote, setPayNote] = useState('')
  const [payError, setPayError] = useState('')
  const [payTxHash, setPayTxHash] = useState('')
  const [payPassEntry, setPayPassEntry] = useState('')

  // ── Pay button — static logo (no flip) ──────────────────────────────────

  // ── Pending attachments (staged, uploaded only on Send) ──────────────────
  const [pendingFiles, setPendingFiles] = useState<{ id: string; file: File; previewUrl: string | null; isImage: boolean }[]>([])
  const [uploadProgress, setUploadProgress] = useState(false)

  const messageInputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize the textarea (WhatsApp-style) — grows up to ~6 lines then scrolls
  const autoResize = useCallback(() => {
    const el = messageInputRef.current
    if (!el) return
    const maxHeight = 132 // ~6 lines
    // The textarea's className has `transition-[height]` for a smooth
    // grow/shrink animation — but that transition fights the very
    // technique below: right after resetting height to '22px', the
    // element's own RENDERED height (mid-transition) briefly stays close
    // to whatever it was before, which inflates clientHeight and the
    // scrollHeight read that follows. Growing still worked despite this
    // (more content always reports a bigger scrollHeight regardless), but
    // erasing text back down read a stale, still-large scrollHeight and
    // the box never actually shrank back to its single-line size.
    // Suspending the transition for just this reset+measure step (and
    // forcing one synchronous reflow before restoring it) fixes the
    // measurement without losing the animated look for the user.
    const prevTransition = el.style.transition
    el.style.transition = 'none'
    // Reset to min first without 'auto' (which causes layout flash)
    el.style.height = '22px'
    const newHeight = Math.min(el.scrollHeight, maxHeight)
    el.style.height = newHeight + 'px'
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
    void el.offsetHeight // force the reset above to apply before re-enabling the transition
    el.style.transition = prevTransition
  }, [])

  // autoResize is now called directly in onChange — no useEffect needed (avoids re-render blink)

  // ── Fetch messages using supabase-js (SELECT works with sb_publishable_ key) ──
  const fetchMessagesFromDB = async (conversationId: string, limit = 50): Promise<ChatMessage[]> => {
    try {
      // Fetch newest `limit` first (DESC), then reverse for display order.
      // Defaults to 50 for the initial open — matches WhatsApp/Telegram-style
      // lazy loading instead of pulling the entire history up front. Older
      // messages are fetched separately via loadOlderMessages() only when
      // the user actually scrolls up to them.
      const { data, error } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_id, content, type, payment_amount, payment_tx_hash, token_symbol, is_read, created_at, delivered_at, read_at, reply_to_id, forwarded, deleted_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) {
        console.error('[Chat] fetchMessages error:', error.message)
        return await loadMessages(conversationId)
      }

      const rows = (data ?? []) as ChatMessage[]

      // Auto-delete oldest 100 messages when total exceeds 400
      if (rows.length >= 800) {
        // rows is DESC so last items are oldest
        const oldest100 = rows.slice(-100).map(m => m.id)
        supabase
          .from('messages')
          .delete()
          .in('id', oldest100)
          .then(({ error: delErr }) => {
          })
      }

      // Reverse to get oldest→newest order for display
      const ordered = [...rows].reverse()

      // Deduplicate by id
      const seen = new Set<string>()
      const deduped = ordered.filter(m => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })

      return deduped
    } catch (e: any) {
      console.error('[Chat] fetchMessages threw:', e?.message)
      return await loadMessages(conversationId)
    }
  }

  // ── Lazy history — fetch the next page of OLDER messages, only called on
  // scroll-to-top. Keeps the initial open fast (50 messages) while still
  // letting the user scroll back through full history a page at a time,
  // same pattern as WhatsApp/Telegram/Signal.
  const loadOlderMessages = async (conversationId: string, beforeCreatedAt: string, pageSize = 50): Promise<ChatMessage[]> => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, conversation_id, sender_id, content, type, payment_amount, payment_tx_hash, token_symbol, is_read, created_at, delivered_at, read_at, reply_to_id, forwarded, deleted_at')
        .eq('conversation_id', conversationId)
        .lt('created_at', beforeCreatedAt)
        .order('created_at', { ascending: false })
        .limit(pageSize)
      if (error) { console.error('[Chat] loadOlderMessages error:', error.message); return [] }
      return [...((data ?? []) as ChatMessage[])].reverse()
    } catch (e: any) {
      console.error('[Chat] loadOlderMessages threw:', e?.message)
      return []
    }
  }

  // ── Setup conversation — always fetches fresh from Supabase ─────────────
  useEffect(() => {
    if (!user?.id || !id) return
    setupConversation()
  }, [id, user?.id])
  // Session just linked to the account — reload what the database hid before.
  useEffect(() => {
    if (!user?.id || !id) return
    const on = () => setupConversation()
    window.addEventListener('meshport:session-bound', on)
    return () => window.removeEventListener('meshport:session-bound', on)
  }, [id, user?.id])

  // Positions the view once the fresh fetch resolves, for conversations
  // that had no cache to show instantly (so the layout effect above never
  // got a chance to run its own positioning). If the layout effect DID
  // already position things (the cached-content path), this only handles
  // revealing the content — never repositions a second time, which would
  // show up as an unwanted extra jump right after the first one settled.
  const positionInitialView = () => {
    requestAnimationFrame(() => {
      if (!hasPositionedInitialScrollRef.current) {
        const el = messagesAreaRef.current
        const target = firstUnreadIdRef.current && document.getElementById(`msg-${firstUnreadIdRef.current}`)
        if (el && target && unreadCountRef.current > 0) {
          const containerTop = el.getBoundingClientRect().top
          const targetTop = target.getBoundingClientRect().top
          const CONTEXT_ABOVE_DIVIDER_PX = 72
          el.scrollTop = Math.max(0, el.scrollTop + (targetTop - containerTop) - CONTEXT_ABOVE_DIVIDER_PX)
        } else if (el) {
          el.scrollTop = el.scrollHeight
        }
        hasPositionedInitialScrollRef.current = true
      }
      setMessagesReady(true)
    })
  }

  const setupConversation = async () => {
    if (!id || !user?.id) return
    setLoading(true)
    const cachedId = id.startsWith('new_') ? null : id
    // Only hide if THIS conversation has no cache — e.g. switching from an
    // already-cached chat straight into a brand new one. If it's cached,
    // stay visible the whole time; the background fetch below will just
    // silently update in place with no visible hide/reveal at all.
    if (!cachedId || !_cachedMessages[cachedId]?.length) setMessagesReady(false)
    setHasMoreHistory(true)

    // Show cached messages immediately while fetching fresh
    if (cachedId && _cachedMessages[cachedId]?.length) {
      setMessages(filterDeleted(_cachedMessages[cachedId]))
    }
    if (cachedId && _cachedOtherUser[cachedId]) {
      setOtherUser(_cachedOtherUser[cachedId])
    }

    try {
      if (id.startsWith('new_')) {
        const otherId = id.replace('new_', '')

        const [otherRes, convId] = await Promise.all([
          supabase.from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at').eq('id', otherId).maybeSingle(),
          ensureConversation(user!.id, otherId),
        ])

        const otherData = otherRes.data
        if (otherData) {
          setOtherUser(otherData)
          _cachedOtherUser[otherId] = otherData
        }
        if (!convId) { console.error('[Chat] failed to create conversation'); navigate('/chat'); return }

        _setConvId(convId)
        const msgs = await fetchMessagesFromDB(convId)
        _cachedMessages[convId] = msgs
        setMessages(filterDeleted(msgs))
        if (msgs.length < 50) setHasMoreHistory(false)
        {
          const unreadMsgs = msgs.filter(m => !m.is_read && m.sender_id !== user!.id)
          firstUnreadIdRef.current = unreadMsgs[0]?.id || null
          firstUnreadAtRef.current = unreadMsgs[0]?.created_at || null
          unreadCountRef.current = unreadMsgs.length
        }

      } else {
        // Set convId immediately so the realtime subscription starts right
        // away, and kick off the messages fetch in parallel with the
        // conversation-row lookup below — previously this awaited the
        // conversation row FIRST and only started fetching messages after
        // it resolved, even though `id` (the conversation id) is already
        // known from the URL and messages don't actually need anything from
        // that row. That was one full extra network round-trip of pure
        // waiting tacked onto every chat open.
        _setConvId(id)

        const [convRes, msgs] = await Promise.all([
          supabase.from('conversations').select('*').eq('id', id).maybeSingle(),
          fetchMessagesFromDB(id),
        ])
        const conv = convRes.data
        if (!conv) { navigate('/chat'); return }

        _cachedMessages[id] = msgs
        setMessages(filterDeleted(msgs))
        if (msgs.length < 50) setHasMoreHistory(false)
        {
          const unreadMsgs = msgs.filter(m => !m.is_read && m.sender_id !== user!.id)
          firstUnreadIdRef.current = unreadMsgs[0]?.id || null
          firstUnreadAtRef.current = unreadMsgs[0]?.created_at || null
          unreadCountRef.current = unreadMsgs.length
        }

        const otherId = conv.participant_a === user!.id ? conv.participant_b : conv.participant_a
        const otherData = _cachedOtherUser[otherId] ?? (await supabase.from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at').eq('id', otherId).maybeSingle()).data
        if (otherData) {
          setOtherUser(otherData)
          _cachedOtherUser[otherId] = otherData
        }
      }
    } catch (e) {
      console.error('[Chat] setupConversation error:', e)
    } finally {
      setLoading(false)
      // Lands on the first unread message if there is one (matching real
      // WhatsApp/Telegram behavior), otherwise the latest message. Not a
      // restored absolute scroll pixel value — that approach previously
      // caused its own bug, since an old pixel offset stops meaning
      // anything sensible once content height changes between visits.
      setTimeout(positionInitialView, 80)
    }
  }

  // ── Realtime subscription — supabase-js postgres_changes ─────────────────
  // supabase-js realtime works with sb_publishable_ key (confirmed via ChatListPage)
  useEffect(() => {
    if (!conversationId || !user?.id) return

    // Only mark messages read while the tab/app is actually in the
    // foreground — marking as read just because data was fetched or a
    // realtime event arrived (regardless of whether anyone's actually
    // looking at the screen right now) isn't real "read" state. If the tab
    // is backgrounded when this would fire, defer it and catch up the
    // moment the tab becomes visible again instead of silently dropping it.
    let pendingMarkRead = false
    const tryMarkRead = () => {
      if (document.visibilityState === 'visible') {
        pendingMarkRead = false
        markRead(conversationId!, user!.id)
      } else {
        pendingMarkRead = true
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && pendingMarkRead) tryMarkRead()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const clearedCount = markConversationReadLocally(conversationId)
    if (clearedCount > 0) useChatUnreadStore.getState().decrementBy(clearedCount)
    invalidateConversationsCache()
    // Real delay, not instant-on-mount — marking read the moment data
    // loads isn't "the user has actually seen these messages," it's just
    // "a fetch resolved." 1.2s is enough for the screen to have actually
    // rendered and been looked at before counting it as read.
    const initialMarkReadTimer = setTimeout(tryMarkRead, 1200)

    const unsubscribe = subscribeWithRetry(supabase, 'msgs-' + conversationId, channel => channel
      .on('postgres_changes', {
        event:  'INSERT',
        schema: 'public',
        table:  'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        const newMsg = payload.new as ChatMessage

        // /api/send-message.ts inserts TWO rows per payment: a 'payment_sent'
        // row owned by the real sender, and a 'payment_received' row whose
        // sender_id is set to the recipient (a view-filter convention, not a
        // real sender). Each viewer should only ever see the one row meant
        // for them — ignore the other party's echo before it ever enters state.
        //
        // SELF-TRANSFER: sender and recipient are the SAME user, so both rows
        // have sender_id === user.id and neither of the two checks below can
        // tell them apart on that basis alone — without this extra check both
        // rows would survive, showing one "Sent" bubble AND one "Received"
        // bubble for a single self-payment. In a self-chat the 'payment_sent'
        // row alone is the correct, complete record — always drop the
        // 'payment_received' echo here regardless of sender_id.
        const isSelfChat = !!(user?.id && otherUser?.id && otherUser.id === user.id)
        if (newMsg.type === 'payment_received' && (isSelfChat || newMsg.sender_id !== user!.id)) return
        // A payment TO me: the payer's 'payment_sent' row isn't shown here (my
        // 'payment_received' row is), but it's the row that counts as unread
        // in the chat list — so it must still be marked read while I'm here.
        // (Returning before tryMarkRead left an unread dot after every
        // payment received during a live chat.)
        if (newMsg.type === 'payment_sent'     && newMsg.sender_id !== user!.id) { tryMarkRead(); return }

        setMessages(prev => {
          // Already present by exact id — skip (handles race with optimistic replace)
          if (prev.find(m => m.id === newMsg.id)) return prev
          // Already present by tx hash — skip (handles payment cards where the
          // optimistic copy was already swapped in by persistMessage())
          if (newMsg.payment_tx_hash && prev.find(m => m.payment_tx_hash === newMsg.payment_tx_hash)) return prev

          // Replace matching optimistic (same sender + type, plus tx hash or content match)
          const optIdx = prev.findIndex(m =>
            m.id.startsWith('optimistic_') &&
            m.sender_id === newMsg.sender_id &&
            m.type      === newMsg.type &&
            (
              (newMsg.payment_tx_hash && m.payment_tx_hash === newMsg.payment_tx_hash) ||
              m.content === newMsg.content ||
              m.content === _plainByContent.get(newMsg.content) ||
              (!!(m as any)._remote && (_plainByContent.get(newMsg.content) ?? '').includes((m as any)._remote))
            )
          )
          const next = optIdx !== -1
            ? prev.map((m, i) => i === optIdx ? newMsg : m)
            : [...prev, { ...newMsg, _isNewArrival: true }]

          _cachedMessages[conversationId] = next
          return next
        })

        if (newMsg.sender_id !== user!.id) {
          setOtherTyping(false)
          tryMarkRead()
          if (!wasNearBottomRef.current) setNewBelow(n => n + 1)
        }
        // Only auto-scroll if already near the bottom — never yank someone
        // away from history they're actively reading just because a new
        // message arrived. This is the exact rule requirement #6 asks for.
        if (wasNearBottomRef.current) {
          scrollToBottom()
          // Catch-up correction — payment cards (and any other animated
          // message content) can still be growing to their final height when
          // the immediate scrollToBottom() above measures scrollHeight, which
          // silently lands the scroll short of the true bottom, cutting off
          // exactly the newly-arrived message this is supposed to reveal.
          // 200ms is comfortably past any entrance animation's duration.
          setTimeout(() => scrollToBottom(false), 200)
        }
      })
      // BUG FIX: this channel only ever listened for INSERT. "Delete for
      // everyone" (handleDeleteForEveryone) does `supabase.from('messages')
      // .update({ content: '[deleted]', ... })` — an UPDATE, not an INSERT —
      // so a recipient with this exact thread already open never received
      // it live; only a full reload (which re-fetches from the DB fresh)
      // ever showed the message as deleted. The chat-LIST channel above
      // already correctly listens for message UPDATEs (to refresh unread
      // badges); this per-thread channel just never got the same handler.
      .on('postgres_changes', {
        event:  'UPDATE',
        schema: 'public',
        table:  'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        const updated = payload.new as ChatMessage
        setMessages(prev => {
          if (!prev.some(m => m.id === updated.id)) return prev
          const next = prev.map(m => m.id === updated.id ? { ...m, ...updated } : m)
          _cachedMessages[conversationId] = next
          return next
        })
      }),
      {
        // Reconnected after a drop — pull anything sent during the gap
        // (the fresh socket only sees INSERTs from here forward) and merge
        // it in the same de-duplicated way as fetchMessagesFromDB does.
        onReconnect: () => {
          fetchMessagesFromDB(conversationId).then(msgs => {
            setMessages(prev => {
              const byId = new Map<string, ChatMessage>(prev.map(m => [m.id, m]))
              for (const m of msgs) byId.set(m.id, m)
              const next: ChatMessage[] = Array.from(byId.values()).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
              _cachedMessages[conversationId] = next
              return filterDeleted(next)
            })
          }).catch(() => {})
        },
      }
    )

    return () => {
      clearTimeout(initialMarkReadTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribe()
      // Leaving a conversation that was on screen: everything in it has been
      // seen. Mark it read now (anything that arrived in the last moment, or
      // before the delayed first mark fired) and keep the list's badge at 0
      // until the write lands.
      if (document.visibilityState === 'visible') {
        _readOverrides[conversationId] = { since: Date.now(), expiresAt: Date.now() + 5000 }
        const cleared = markConversationReadLocally(conversationId)
        if (cleared > 0) useChatUnreadStore.getState().decrementBy(cleared)
        markRead(conversationId, user.id)
      }
    }
  }, [conversationId, user?.id])

  // Stats card: hide on keyboard open, show on keyboard close
  // Only touches statsCardRef DOM — nothing else
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    // Wait for full render before capturing base height
    let baseHeight = 0
    const init = setTimeout(() => { baseHeight = vv.height }, 800)

    const hide = () => {
      const c = statsCardRef.current
      if (!c || isKeyboardOpen.current) return
      isKeyboardOpen.current = true
      c.style.maxHeight = '0px'
      c.style.opacity = '0'
      c.style.transform = 'translateY(-10px)'
      c.style.pointerEvents = 'none'
      c.style.overflow = 'hidden'
      // Scroll re-anchoring on keyboard open is now handled generally by
      // the viewportHeight useLayoutEffect above (which also correctly
      // respects wasNearBottomRef — never force-scrolling someone away
      // from history they're reading, unlike this used to).
    }

    const show = () => {
      const c = statsCardRef.current
      if (!c || !isKeyboardOpen.current) return
      isKeyboardOpen.current = false
      c.style.maxHeight = '200px'
      c.style.opacity = '1'
      c.style.transform = 'translateY(0px)'
      c.style.pointerEvents = ''
    }

    const onResize = () => {
      if (!baseHeight) return
      const diff = baseHeight - vv.height
      if (diff > 100) hide()
      else if (diff < 50) show()
    }

    vv.addEventListener('resize', onResize)
    return () => {
      clearTimeout(init)
      vv.removeEventListener('resize', onResize)
    }
  }, [])


  // Matches for in-conversation search — chronological order, text messages
  // only (payment cards don't have freeform text worth searching).
  const msgSearchMatches = msgSearchQuery.trim()
    // Search the decrypted text (encrypted messages never matched before).
    ? messages.filter(m => m.type === 'text' && m.content !== '[deleted]' && messagePreview(m.content).toLowerCase().includes(msgSearchQuery.trim().toLowerCase())).map(m => m.id)
    : []

  const scrollToMatch = (index: number) => {
    const id = msgSearchMatches[index]
    if (!id) return
    const el = messageRefs.current[id]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const closeMsgSearch = () => { setMsgSearchOpen(false); setMsgSearchQuery(''); setMsgSearchIndex(0) }

  useEffect(() => {
    if (!msgSearchQuery.trim() || msgSearchMatches.length === 0) return
    const t = setTimeout(() => scrollToMatch(msgSearchIndex), 50)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgSearchQuery, msgSearchIndex, msgSearchMatches.length])

  const scrollToBottom = (smooth = true) => {
    requestAnimationFrame(() => {
      const el = messagesEndRef.current
      if (!el) return
      const parent = el.parentElement
      if (!parent) return
      if (smooth) {
        setMessagesReady(true)  // ensure visible for smooth scrolls
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' })
      } else {
        // Instant scroll — scroll first then reveal to prevent seeing the jump
        parent.scrollTop = parent.scrollHeight
        setMessagesReady(true)
      }
    })
  }

  // ── Message delete handlers ──────────────────────────────────────────────
  const handleDeleteForMe = (msg: any) => {
    // Persist so it survives refresh (and any way the chat is opened)
    addDeletedForMe([msg.id])
    setMessages(prev => prev.filter(m => m.id !== msg.id))
    setDeleteMsg(null)
  }

  const handleDeleteForEveryone = async (msg: any) => {
    setDeleting(true)
    try {
      const { supabase } = await import('@/lib/supabase')
      const { error } = await supabase.from('messages')
        .update({ content: '[deleted]', type: 'text' })
        .eq('id', msg.id)
      if (error) throw new Error(/2 days/.test(error.message) ? 'Messages can only be deleted for everyone within 2 days' : 'Could not delete — try again')
      // Replace locally with deleted placeholder
      setMessages(prev => prev.map(m =>
        m.id === msg.id ? { ...m, content: '[deleted]', type: 'text', deleted_at: new Date().toISOString() } : m
      ))
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not delete — try again', 'error')
    }
    setDeleting(false)
    setDeleteMsg(null)
  }

  const startMsgLongPress = useCallback((msg: any, isMine: boolean) => {
    // Only text, image and file messages are deletable — never payment cards
    const isText  = msg.type === 'text' && !msg.content?.startsWith('[IMAGE](') && !msg.content?.startsWith('[FILE:')
    const isImage = msg.content?.startsWith('[IMAGE](')
    const isFile  = msg.content?.startsWith('[FILE:')
    if (!isText && !isImage && !isFile) return
    // Still-sending or failed messages have nothing to manage yet.
    if (String(msg.id).startsWith('optimistic_') || msg._failed) return
    msgLongPressTimer.current = setTimeout(() => {
      msgLongPressTimer.current = null
      justLongPressedRef.current = Date.now()
      try { navigator.vibrate?.(18) } catch { /* not supported */ }
      setSelected(prev => {
        if (prev[msg.id]) return prev
        return { ...prev, [msg.id]: { ...msg, isMine } }
      })
    }, 420)
  }, [])

  // In selection mode a tap adds / removes a message (never opens it).
  const toggleSelected = (msg: any, isMine: boolean) => {
    if (Date.now() - justLongPressedRef.current < 450) return // the long-press's own release
    const selectable = (msg.type === 'text') && !String(msg.id).startsWith('optimistic_') && !msg._failed && !codeFromLink(plainTextOf(msg.content))
    setSelected(prev => {
      if (prev[msg.id]) { const n = { ...prev }; delete n[msg.id]; return n }
      return selectable ? { ...prev, [msg.id]: { ...msg, isMine } } : prev
    })
  }
  const clearSelection = () => setSelected({})

  // What the selection allows (WhatsApp rules).
  const selDeleted = selectedList.some((m: any) => m.content === '[deleted]')
  const selAllText = selectedList.every((m: any) => m.content !== '[deleted]' && !parseMedia(plainTextOf(m.content)) && !!plainTextOf(m.content))
  const canCopy = selecting && selAllText
  const canForward = selecting && !selDeleted
  const canInfo = selectedList.length === 1 && (selectedList[0] as any).isMine && !selDeleted

  const copySelected = async () => {
    const text = selectedList.map((m: any) => plainTextOf(m.content)).join('\n')
    try { await navigator.clipboard.writeText(text); showToastMessage(selectedList.length > 1 ? `${selectedList.length} messages copied` : 'Message copied', 'success') }
    catch { showToastMessage('Could not copy', 'error') }
    clearSelection()
  }

  const deleteForMeMany = (msgs: any[]) => {
    const ids = msgs.map(m => m.id)
    addDeletedForMe(ids)
    setMessages(prev => prev.filter(m => !ids.includes(m.id)))
    setDeleteTargets(null)
    clearSelection()
    // "Deleted for you · UNDO" for 5 seconds.
    setUndoDeleted(prev => {
      if (prev) clearTimeout(prev.timer)
      return { msgs, timer: setTimeout(() => setUndoDeleted(null), 5000) }
    })
  }
  const undoDelete = () => {
    if (!undoDeleted) return
    clearTimeout(undoDeleted.timer)
    const ids = undoDeleted.msgs.map((m: any) => m.id)
    removeDeletedForMe(ids)
    const restored = undoDeleted.msgs.map(({ isMine, ...m }: any) => m)
    setMessages(prev => [...prev.filter(m => !ids.includes(m.id)), ...restored].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()))
    setUndoDeleted(null)
  }
  const deleteForEveryoneMany = async (msgs: any[]) => {
    setDeleting(true)
    let failed = 0
    const { supabase } = await import('@/lib/supabase')
    for (const m of msgs) {
      const { error } = await supabase.from('messages').update({ content: '[deleted]', type: 'text' }).eq('id', m.id)
      if (error) { failed++; continue }
      setMessages(prev => prev.map(x => x.id === m.id ? { ...x, content: '[deleted]', type: 'text', deleted_at: new Date().toISOString() } : x))
    }
    setDeleting(false)
    setDeleteTargets(null)
    clearSelection()
    if (failed) showToastMessage(failed === 1 ? 'Could not delete 1 message — try again' : `Could not delete ${failed} messages — try again`, 'error')
  }

  const cancelMsgLongPress = useCallback(() => {
    if (msgLongPressTimer.current) {
      clearTimeout(msgLongPressTimer.current)
      msgLongPressTimer.current = null
    }
  }, [])

  const handleImageTap = useCallback((src: string, msgId?: string) => {
    if (msgId) { setViewerStartId(msgId); return }
    setViewerSrc(src)
    setViewerType('image')
  }, [])

  // `overrideText`: send this text instead of the composer's (a merchant bill);
  // the user's own draft and pending files are left untouched.
  // Sends one text message: shows it at once (clock tick), encrypts, saves.
  // On failure it STAYS in the chat, marked "Not sent · Tap to retry", with
  // its text — never silently disappears. `retryId` resends that message.
  const sendTextMessage = async (text: string, convId: string, retryId?: string, replyToId?: string | null) => {
    if (!user?.id) return
    const optId = retryId ?? 'optimistic_' + Date.now() + Math.random()
    if (retryId) {
      setMessages(prev => { const n = prev.map(m => m.id === retryId ? { ...m, _failed: false, created_at: new Date().toISOString() } : m); _cachedMessages[convId] = n; return n })
    } else {
      const optMsg: ChatMessage = {
        id: optId, conversation_id: convId, sender_id: user.id,
        content: text, type: 'text', payment_amount: null, payment_tx_hash: null,
        token_symbol: null, is_read: false, created_at: new Date().toISOString(),
        reply_to_id: replyToId ?? null,
      }
      setMessages(prev => { const n = [...prev, optMsg]; _cachedMessages[convId] = n; return n })
      scrollToBottom(false)
    }
    const replyId = replyToId ?? (retryId ? (latestMessagesRef.current.find(m => m.id === retryId)?.reply_to_id ?? null) : null)
    let saved: ChatMessage | null = null
    let encryptedContent = text
    try {
      // Bill / payment-request cards are payment records, stored as plain
      // text (like payment cards). Everything else is end-to-end encrypted.
      const isPaymentRecordCard = /^(🧾 Bill|💸 Payment request)\b/u.test(text) && !!codeFromLink(text)
      const { encryptText } = await import('@/lib/chatCrypto')
      encryptedContent = isPaymentRecordCard ? text : await encryptText(text, convKey)
      // Known plaintext for this ciphertext — the saved copy (and the live
      // echo) show the text at once instead of flashing empty.
      _plainByContent.set(encryptedContent, text)
      saved = await persistMessage({ conversationId: convId, senderId: user.id, content: encryptedContent, type: 'text', replyToId: replyId })
    } catch (e) {
      console.error('[Chat] send failed:', e)
    }
    if (saved) {
      const real = saved
      setMessages(prev => {
        // The live echo may already have replaced the optimistic copy — then
        // there's nothing to swap. Otherwise swap it and drop any duplicate.
        if (!prev.some(m => m.id === optId)) return prev
        const withoutEcho = prev.filter(m => m.id !== real.id)
        const n = withoutEcho.map(m => m.id === optId ? real : m)
        _cachedMessages[convId] = n
        return n
      })
      touchConversation(convId, encryptedContent, user.id, 'text')
    } else {
      setMessages(prev => { const n = prev.map(m => m.id === optId ? { ...m, _failed: true } : m); _cachedMessages[convId] = n; return n })
    }
  }

  // ── Photos & files: shown in the chat at once with a progress ring; cancel
  // or retry on the bubble itself. The picked bytes are kept until saved.
  const uploadJobsRef = useRef<Record<string, { blob: Blob; name: string; isImage: boolean; meta: { w?: number; h?: number; s?: number; g?: string }; caption: string; localUrl: string; abort?: () => void }>>({})
  const patchMsg = (convId: string, mid: string, patch: Record<string, any>) =>
    setMessages(prev => { const n = prev.map(m => m.id === mid ? { ...m, ...patch } : m); _cachedMessages[convId] = n; return n })

  const runUpload = async (optId: string, convId: string) => {
    const job = uploadJobsRef.current[optId]
    if (!job || !user?.id) return
    patchMsg(convId, optId, { _failed: false, _upload: { progress: 0.02 } })
    try {
      const { encryptBlob, encryptText } = await import('@/lib/chatCrypto')
      const { blob: up, ivBase64, encrypted } = await encryptBlob(job.blob, convKey)
      const ext = job.isImage ? (job.blob.type === 'image/png' ? 'png' : job.blob.type === 'image/gif' ? 'gif' : 'jpg') : (job.name.split('.').pop() || 'bin')
      const path = `chat/${convId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      let last = 0
      const handle = uploadWithProgress(path, up, encrypted ? 'application/octet-stream' : (job.blob.type || mimeOf(job.name)), prog => {
        const now = Date.now()
        if (prog < 1 && now - last < 120) return
        last = now
        patchMsg(convId, optId, { _upload: { progress: prog } })
      })
      job.abort = handle.abort
      const remote = withMeta(await handle.promise, job.meta)
      // The saved copy shows the local bytes at once — no re-download, no flash.
      putCachedMedia(remote, job.blob, job.localUrl)
      patchMsg(convId, optId, { _remote: remote.split('#')[0] })
      const safeName = encodeURIComponent(job.name)
      const marker = job.isImage
        ? (encrypted ? `[IMAGE-E:${ivBase64}](${remote})` : `[IMAGE](${remote})`)
        : (encrypted ? `[FILE-E:${safeName}:${ivBase64}](${remote})` : `[FILE:${safeName}](${remote})`)
      // The caption travels in the same message, under the marker.
      const plain = job.caption.trim() ? `${marker}\n${job.caption.trim()}` : marker
      const content = await encryptText(plain, convKey)
      _plainByContent.set(content, plain)
      const saved = await persistMessage({ conversationId: convId, senderId: user.id, content, type: 'text' })
      if (!saved) throw new Error('save failed')
      setMessages(prev => {
        if (!prev.some(m => m.id === optId)) return prev
        const n = prev.filter(m => m.id !== saved.id).map(m => m.id === optId ? saved : m)
        _cachedMessages[convId] = n
        return n
      })
      touchConversation(convId, content, user.id, 'text')
      delete uploadJobsRef.current[optId]
    } catch (e: any) {
      if (e?.message === 'cancelled') return
      patchMsg(convId, optId, { _failed: true })
      showToastMessage(`Couldn't send ${job.isImage ? 'photo' : job.name} — tap Retry`, 'error')
    }
  }

  /** Photos (compressed; HD = larger) or files → chat, each with progress. */
  const sendMedia = async (items: Array<{ file: File; caption: string }>, hd: boolean, asDocuments: boolean) => {
    const convId = conversationIdRef.current || conversationId
    if (!convId || !user?.id) return
    const MAX = 16 * 1024 * 1024
    const queued: string[] = []
    // Photos / files picked together share a batch id so they show as one
    // album / one bubble, however long each upload takes.
    const batch = items.length > 1 ? Math.random().toString(36).slice(2, 12) : undefined
    for (const { file, caption } of items) {
      let isImage = !asDocuments && file.type.startsWith('image/')
      let blob: Blob = file
      let meta: { w?: number; h?: number; s?: number; g?: string } = { s: file.size }
      if (isImage) {
        const prepared = await preparePhoto(file, hd)
        if (prepared) { blob = prepared.blob; meta = { w: prepared.w, h: prepared.h, s: prepared.blob.size } }
        else isImage = false // can't display it here (e.g. HEIC) → send as a file
      }
      if (batch) meta.g = batch
      if (blob.size > MAX) { showToastMessage(`"${file.name}" is too large (max 16 MB)`, 'error'); continue }
      const localUrl = URL.createObjectURL(blob)
      const optId = 'optimistic_' + Date.now() + Math.random()
      const marker = isImage ? `[IMAGE](${withMeta(localUrl, meta)})` : `[FILE:${encodeURIComponent(file.name)}](${withMeta(localUrl, meta)})`
      const content = caption.trim() ? `${marker}\n${caption.trim()}` : marker
      uploadJobsRef.current[optId] = { blob, name: file.name, isImage, meta, caption, localUrl }
      const optMsg: any = {
        id: optId, conversation_id: convId, sender_id: user.id, content, type: 'text', payment_amount: null, payment_tx_hash: null,
        token_symbol: null, is_read: false, created_at: new Date().toISOString(), _upload: { progress: 0 },
      }
      setMessages(prev => { const n = [...prev, optMsg]; _cachedMessages[convId] = n; return n })
      queued.push(optId)
    }
    setDividerDismissed(true)
    scrollToBottom()
    for (const id of queued) await runUpload(id, convId)
  }

  const cancelUpload = useCallback((msg: any) => {
    const convId = conversationIdRef.current || conversationId
    const job = uploadJobsRef.current[msg.id]
    job?.abort?.()
    if (job) URL.revokeObjectURL(job.localUrl)
    delete uploadJobsRef.current[msg.id]
    setMessages(prev => { const n = prev.filter(m => m.id !== msg.id); if (convId) _cachedMessages[convId] = n; return n })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  const retryMessage = useCallback((msg: any) => {
    const convId = conversationIdRef.current || conversationId
    if (!convId || !msg?._failed) return
    if (uploadJobsRef.current[msg.id]) { void runUpload(msg.id, convId); return }
    void sendTextMessage(String(msg.content ?? ''), convId, msg.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, convKey, user?.id])

  const handleSend = async (overrideText?: unknown) => {
    const isOverride = typeof overrideText === 'string'
    const text = (isOverride ? overrideText : messageText).trim()
    const currentConvId = conversationIdRef.current || conversationId
    if ((!text && (isOverride || pendingFiles.length === 0)) || !currentConvId || !user?.id || sending) return
    messageInputRef.current?.focus()
    setSending(true)

    if (!isOverride && pendingFiles.length > 0) {
      const filesToSend = [...pendingFiles]
      setPendingFiles([])
      filesToSend.forEach(pf => { if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl) })
      // Staged files (Document / File) are sent as files; photos go through
      // the preview screen instead.
      // Text typed with them is their caption (on the last one), not a
      // separate message.
      void sendMedia(filesToSend.map((pf, i) => ({ file: pf.file, caption: i === filesToSend.length - 1 ? text : '' })), false, true)
      if (!isOverride) {
        setMessageText('')
        if (messageInputRef.current) messageInputRef.current.style.height = '22px'
      }
      setReplyTo(null)
      setSending(false)
      scrollToBottom()
      return
    }

    if (text) {
      messageInputRef.current?.focus()
      if (!isOverride) {
        setMessageText('')
        if (messageInputRef.current) messageInputRef.current.style.height = '22px'
      }
      setDividerDismissed(true)
      const replyId = replyTo?.id ?? null
      setReplyTo(null)
      await sendTextMessage(text, currentConvId, undefined, replyId)
    }

    setSending(false)
    scrollToBottom()
    setTimeout(() => scrollToBottom(false), 200)
    requestAnimationFrame(() => {
      if (isKeyboardOpen.current) messageInputRef.current?.focus()
    })
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    // Photos picked with "Image" open the preview screen (caption, HD, add more).
    if (pickModeRef.current === 'image') {
      const imgs = (files as File[]).filter(f => f.type.startsWith('image/'))
      const add = imgs.slice(0, 30).map(f => ({ id: `pv_${Date.now()}_${Math.random().toString(36).slice(2)}`, file: f, url: URL.createObjectURL(f), caption: '' }))
      if (add.length) setPreviewItems(prev => [...(prev ?? []), ...add].slice(0, 30))
      return
    }
    const maxSize = 16 * 1024 * 1024
    const staged: typeof pendingFiles = []
    for (const file of (files as any[]) as File[]) {
      if (file.size > maxSize) { showToastMessage(`"${file.name}" is too large (max 16 MB)`, 'error'); continue }
      const isImage = file.type.startsWith('image/')
      staged.push({ id: `pf_${Date.now()}_${Math.random().toString(36).slice(2)}`, file, previewUrl: isImage ? URL.createObjectURL(file) : null, isImage })
    }
    if (staged.length) setPendingFiles(prev => [...prev, ...staged])
  }

  const removePendingFile = (id: string) => {
    setPendingFiles(prev => {
      const target = prev.find(p => p.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(p => p.id !== id)
    })
  }

  const uploadOneFile = async (file: File): Promise<string | null> => {
    try {
      const { supabase } = await import('@/lib/supabase')
      const { encryptBlob, encryptText } = await import('@/lib/chatCrypto')
      const ext = file.name.split('.').pop()
      const fileName = `chat/${conversationId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

      // Encrypt the file's own bytes with the conversation key BEFORE
      // upload — the storage bucket serves public URLs (see the comment on
      // getPublicUrl below), so without this step anyone with the link
      // could view the raw file, not just the two people in this chat.
      // Falls back to uploading the original bytes unchanged if convKey is
      // null (see encryptBlob's own comment — same "recipient hasn't
      // opened a build with this feature yet" fallback text uses).
      const { blob: uploadBlob, ivBase64, encrypted } = await encryptBlob(file, convKey)

      const { error: uploadErr } = await supabase.storage.from('attachments').upload(fileName, uploadBlob, { cacheControl: '3600', upsert: false, contentType: encrypted ? 'application/octet-stream' : file.type })
      if (uploadErr) { console.error('[Chat] Upload error:', uploadErr.message); return null }
      const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(fileName)
      const fileUrl = urlData.publicUrl

      // Inner marker carries the FILE's own IV (needed to decrypt the blob
      // at that URL) — separate from the message-level e2e:v1: wrapper
      // encryptText adds next, which also hides the filename/URL itself
      // from the server, not just the file content.
      const isImage = file.type.startsWith('image/')
      // File names are URI-encoded so ':', ']' or '(' can't break parsing.
      const safeName = encodeURIComponent(file.name)
      const marker = encrypted
        ? (isImage ? `[IMAGE-E:${ivBase64}](${fileUrl})` : `[FILE-E:${safeName}:${ivBase64}](${fileUrl})`)
        : (isImage ? `[IMAGE](${fileUrl})` : `[FILE:${safeName}](${fileUrl})`)
      const out = await encryptText(marker, convKey)
      _plainByContent.set(out, marker)
      return out
    } catch (e: any) { console.error('[Chat] File upload failed:', e?.message); return null }
  }

  const handlePay = () => {
    if (!otherUser?.username || !otherUser?.wallet_address) { showToastMessage('Recipient wallet not available', 'error'); return }
    setPayAmount(''); setPayToken('USDC'); setPayNote(''); setPayError(''); setPayTxHash('')
    setBillPay(null)
    setLinkPay(null)
    setPayPassEntry('') // clear any stale PIN from a previous payment — otherwise PinKeypad
                         // remounts already "full" and auto-fires onComplete with the old PIN
    // RESILIENCE FIX (2026-09-17): a fresh sheet-open always means a NEW,
    // separate payment attempt — even if it happens to end up with the
    // same recipient/amount/token as an earlier, already-completed one
    // (e.g. paying the same person the same amount again). Without this
    // reset, chatPayIdempotencyKeyRef's signature-based reuse (see its own
    // comment above) would treat that second, genuinely intentional
    // payment as a retry of the first and silently return the FIRST
    // payment's old tx_hash instead of sending a new one. Retries WITHIN
    // one sheet session (form -> confirm -> failed -> form again, same
    // amount still filled in) are unaffected — this only resets at the
    // point a fresh session begins.
    chatPayIdempotencyKeyRef.current = null
    setPayStep('form')
    setShowAmountPad(true)
    // Refresh USDC + EURC + cirBTC balances live when sheet opens
    const addr = useAuthStore.getState().walletAddress || ''
    if (addr) {
      import('@/lib/arcService').then(({ getEURCBalance, getUSDCBalance, getCirBtcBalance }) => {
        getUSDCBalance(addr).then(b => setBalance(b)).catch(() => {})
        getEURCBalance(addr).then(b => setEurcBalance(b)).catch(() => {})
        getCirBtcBalance(addr).then(b => setCirbtcBalance(b)).catch(() => {})
      })
    }
  }
  // A bill / payment-request card in this chat asked to be paid: open the
  // normal in-chat pay sheet with the bill's amount (USDC, fixed) instead
  // of leaving the conversation.
  const handlePayRef = useRef(handlePay)
  handlePayRef.current = handlePay
  useEffect(() => {
    const onBillPay = (e: Event) => {
      const v = (e as CustomEvent<PaymentView>).detail
      if (!v) return
      if (v.status === 'paid') { showToastMessage(`Order #${orderLabel(v)} is already paid`, 'info'); return }
      if (['expired', 'cancelled', 'failed'].includes(v.status)) { showToastMessage('This order can no longer be paid', 'error'); return }
      const payee = otherUser?.wallet_address?.toLowerCase()
      if (!payee || payee !== v.merchantWallet?.toLowerCase()) { navigate(`/pay/r/${v.code}`); return }
      const due = Math.round(Math.max(0, v.amount - v.received) * 1e6) / 1e6
      if (!(due > 0)) return
      handlePayRef.current()
      setBillPay({ code: v.code, number: orderLabel(v), orderNumber: v.orderNumber ?? null, amount: due })
      setPayToken('USDC')
      setPayAmount(String(due))
      setShowAmountPad(false)
    }
    window.addEventListener(BILL_PAY_EVENT, onBillPay)
    return () => window.removeEventListener(BILL_PAY_EVENT, onBillPay)
  }, [otherUser?.wallet_address, navigate])

  // A personal payment link card in this chat: when the link is the chat
  // partner's, pay in-chat (amount prefilled and fixed if the link has one).
  // Otherwise the card opens the link's pay page itself.
  useEffect(() => {
    const onPayLink = (e: Event) => {
      const d = (e as CustomEvent<PersonalPayLink & { handled: boolean }>).detail
      const partner = (otherUser?.username || '').toLowerCase().replace(/\.arc$/, '')
      if (!d || !partner || d.username !== partner) return
      d.handled = true
      handlePayRef.current()
      setLinkPay({ username: d.username, amount: d.amount })
      setPayToken('USDC')
      if (d.amount) { setPayAmount(d.amount); setShowAmountPad(false) }
    }
    window.addEventListener(PAY_LINK_EVENT, onPayLink)
    return () => window.removeEventListener(PAY_LINK_EVENT, onPayLink)
  }, [otherUser?.username])

  // Merchant Ledger → "Receive payment" for a customer: the request card is
  // sent into this chat automatically (once) as soon as the chat is ready.
  const autoSendRef = useRef<string | null>(
    typeof (location.state as any)?.autoSend === 'string' ? String((location.state as any).autoSend).slice(0, 2000) : null
  )
  useEffect(() => {
    const text = autoSendRef.current
    if (!text || sending || !user?.id || !otherUser?.id || convKeyFor !== otherUser.id) return
    if (!(conversationIdRef.current || conversationId)) return
    autoSendRef.current = null
    navigate(location.pathname, { replace: true, state: null })
    void handleSend(text)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, convKeyFor, otherUser?.id, user?.id, sending])


  const recipientClean = (otherUser?.username || '').replace(/\.arc$/, '')

  const totalSent = messages
    .filter(m => (m.type === 'payment_sent') && m.sender_id === user?.id)
    .reduce((s, m) => s + (m.payment_amount || 0), 0)
  const totalReceived = messages
    .filter(m => (m.type === 'payment_sent') && m.sender_id !== user?.id)
    .reduce((s, m) => s + (m.payment_amount || 0), 0)

  const paymentHistory = messages.filter(m => m.type === 'payment_sent').slice().reverse()
  const [showHistory, setShowHistory] = useState(false)
  const [showProfile, setShowProfile] = useState(false)

  const executeChatPayment = async () => {
    // Synchronous guard — payStep (React state) doesn't flip to 'processing'
    // until AFTER the async verifyPasscode() call below resolves, leaving a
    // window where a second onComplete fire would slip through and trigger a
    // second real on-chain send. A ref is checked/set synchronously instead.
    if (chatPayInFlightRef.current) return
    chatPayInFlightRef.current = true

    const numAmount = parseFloat(payAmount)
    if (!numAmount || numAmount <= 0) { setPayError('Enter a valid amount'); setPayStep('form'); chatPayInFlightRef.current = false; return }
    if (!otherUser?.wallet_address) { setPayError('Recipient wallet not available'); setPayStep('form'); chatPayInFlightRef.current = false; return }

    // ── Passcode verification — same pattern as PaySendPage ─────────────────
    if (storedPasscode) {
      if (!payPassEntry || payPassEntry.length < 6) {
        setPayError('Enter your 6-digit passcode to confirm.')
        chatPayInFlightRef.current = false
        return
      }
      // PERF FIX (transaction-speed audit): kick off private-key restore
      // concurrently with verifyPasscode below instead of after it -- see
      // PaySendPage.tsx's own verifyAndSend for the full reasoning (two
      // independent PBKDF2 derives from the same passcode, previously run
      // back-to-back on every ChatPay send that didn't already have the
      // key warm in memory). `silent: true` so a wrong PIN doesn't flip on
      // the wallet-recovery banner before "Incorrect passcode" below even
      // shows.
      if (!privateKey) {
        import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(payPassEntry || undefined, { silent: true })).catch(() => {})
      }
      const { verifyPasscode } = await import('@/lib/security')
      const correct = await verifyPasscode(payPassEntry, storedPasscode)
      if (!correct) {
        setPayError('Incorrect passcode. Try again.')
        setPayPassEntry('')
        chatPayInFlightRef.current = false
        return
      }
    }

    setPayError(''); setPayStep('processing')
    payStartRef.current = performance.now()

    let activePrivateKey = privateKey
    if (!activePrivateKey) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(payPassEntry || undefined)
        activePrivateKey = useAuthStore.getState().privateKey
      } catch {}
    }
    if (!activePrivateKey) { setPayError("Couldn't access your wallet on this device. Sign out and re-import your wallet with your recovery phrase or private key to continue."); setPayStep('confirm'); chatPayInFlightRef.current = false; return }

    try {
      const { sendUSDC, sendEURC, sendCirBTC, getUSDCBalance, getEURCBalance, getCirBtcBalance } = await import('@/lib/arcService')

      const idemSignature = `${otherUser.wallet_address}:${numAmount}:${payToken}:${billPay?.code ?? ''}`
      if (chatPayIdempotencyKeyRef.current?.signature !== idemSignature) {
        chatPayIdempotencyKeyRef.current = { signature: idemSignature, key: crypto.randomUUID() }
      }
      const idempotencyKey = chatPayIdempotencyKeyRef.current.key

      // Send the correct token — mirrors PaySendPage's own token-routing
      const result = payToken === 'EURC'
        ? await sendEURC({ privateKey: activePrivateKey, to: otherUser.wallet_address, amount: numAmount, idempotencyKey })
        : payToken === 'cirBTC'
        ? await sendCirBTC({ privateKey: activePrivateKey, to: otherUser.wallet_address, amount: numAmount, idempotencyKey })
        : await sendUSDC({ privateKey: activePrivateKey, to: otherUser.wallet_address, amount: numAmount, idempotencyKey })

      setPayTxHash(result.txHash)

      // Bill payment: link the Arc transfer to the bill so the merchant's
      // card flips to "Payment received" (verified on-chain server-side).
      if (billPay && payToken === 'USDC' && result.txHash) {
        const code = billPay.code
        // Confirmed server-side against the order number + amount.
        const check = { orderNumber: billPay.orderNumber ?? undefined, amount: billPay.amount }
        import('@/lib/merchantPay').then(({ submitPayment, BILL_UPDATED_EVENT }) =>
          submitPayment(code, 'Arc_Testnet', result.txHash, check)
            .then(() => window.dispatchEvent(new CustomEvent(BILL_UPDATED_EVENT, { detail: code })))
        ).catch(e => {
          console.error('[Chat] order payment confirm failed:', e)
          showToastMessage(e instanceof Error ? e.message : 'Could not confirm the order payment', 'error')
        })
      }

      // Save contact payment note so both sender and receiver see it in Activity
      if (result.txHash) {
        import('@/lib/ActivityService').then(({ Activity }) => {
          Activity.send({
            walletAddress:   result.senderAddress,
            txHash:          result.txHash,
            amount:          numAmount,
            tokenSymbol:     payToken || 'USDC',
            toAddress:       result.recipientAddress,
            note:            'Contact Payment',
          }).catch(() => {})
        }).catch(() => {})

        // Confirm in the background — the user already sees success at
        // this point (see setPayTxHash above). This only ever needs to
        // act in the rare case the transaction actually reverted,
        // correcting the row just written optimistically above.
        import('@/lib/arcService').then(({ confirmTransactionInBackground }) => {
          confirmTransactionInBackground(result.txHash as `0x${string}`, ({ success }) => {
            if (success) return
            import('@/lib/ActivityService').then(({ updateActivityStatus }) => {
              updateActivityStatus(`send_${result.txHash.toLowerCase()}`, result.senderAddress, 'failed')
            })
            showToastMessage('Payment failed to confirm on-chain — please check Activity', 'error')
          })
        })
      }

      // Transaction on-chain — ArcScan is source of truth


      // PERF FIX: fire-and-forget — rewards points are a nice-to-have on top
      // of an already-confirmed payment; awaiting this server round trip
      // before showing success only added latency with no correctness
      // benefit. Same fix already applied to Pay/Send, Swap, and Bulk
      // Payout. Internal try/catch still swallows all errors, so this can
      // never produce an unhandled rejection.
      (async () => {
        try {
          const { awardTransactionPoints } = await import('@/lib/rewards')
          const { notifyRewardSend } = await import('@/lib/notifications')
          const { user: u, walletAddress: wa } = useAuthStore.getState()
          const pointUserId = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? `wallet_${wa.toLowerCase().slice(2, 18)}` : null
          if (pointUserId && wa) {
            const r = await awardTransactionPoints({ userId: pointUserId, walletAddress: wa, txHash: result.txHash, actionType: 'chatpay' })
            if (r.pointsAwarded > 0) notifyRewardSend(r.pointsAwarded, payToken || 'USDC')
          }
        } catch {}
      })()

      try {
        const { deriveAddressFromPrivateKey } = await import('@/lib/arc')
        // Fire-and-forget — only refreshes the displayed balance, no reason
        // to block the success screen on it.
        deriveAddressFromPrivateKey(activePrivateKey).then((realAddr: string) => {
          if (payToken === 'EURC') {
            getEURCBalance(realAddr).then(b => setEurcBalance(b)).catch(() => {})
          } else if (payToken === 'cirBTC') {
            getCirBtcBalance(realAddr).then(b => setCirbtcBalance(b)).catch(() => {})
          } else {
            getUSDCBalance(realAddr).then(bal => setBalance(bal)).catch(() => {})
          }
        }).catch(() => {})
      } catch {}

      try {
        const convId = conversationIdRef.current || conversationId
        const token  = payToken || 'USDC'   // always defined — payToken state declared above


        if (!convId) {
          console.error('[Chat] ✗ No conversationId — payment card cannot be saved')
        } else if (!user) {
          console.error('[Chat] ✗ No user — payment card cannot be saved')
        } else {
          // BUG FIX: formatAmount's default 2 decimals truncates a realistic
          // cirBTC amount (e.g. 0.00025) to "0.00" -- this string is the
          // literal, persisted chat message content, not just a display
          // formatting choice, so getting cirBTC's precision right here
          // matters more than anywhere else in this file.
          const payContent = `Sent ${formatAmount(numAmount, chatPayTokenDecimals(token as ChatPayToken))} ${token} to ${recipientClean}.arc${billPay ? ` · Order #${billPay.number}` : ''}`

          // Optimistic card — visible immediately before DB confirms
          const optId  = 'optimistic_pay_' + Date.now()
          const optMsg: ChatMessage = {
            id:               optId,
            conversation_id:  convId,
            sender_id:        user.id,
            content:          payContent,
            type:             'payment_sent',
            payment_amount:   numAmount,
            payment_tx_hash:  result.txHash || null,
            token_symbol:     token,
            is_read:          false,
            created_at:       new Date().toISOString(),
          }
          setMessages(prev => { const n = [...prev, optMsg]; _cachedMessages[convId] = n; return n })
          scrollToBottom()
          setTimeout(() => scrollToBottom(false), 200)

          // BUG FIX: `persistMessage` used to be awaited here, blocking the
          // success screen on a full network round-trip (API → REST
          // fallback) — but the payment card the user actually SEES is the
          // optimistic one added just above, already on screen before this
          // point. Persisting to the DB (and swapping the optimistic card
          // for the real saved row once done) is a background reconciliation
          // step, not something that needs to hold up the "delivered"
          // screen. Same fix as PaySendPage.tsx's runProcessing().
          persistMessage({
            conversationId: convId,
            senderId:       user.id,
            content:        payContent,
            type:           'payment_sent',
            paymentAmount:  numAmount,
            paymentTxHash:  result.txHash || null,
            tokenSymbol:    token,
            senderWalletAddress:    result.senderAddress   || undefined,
            recipientWalletAddress: result.recipientAddress || otherUser?.wallet_address || undefined,
            toUsername: otherUser?.username || undefined,
          }).then(saved => {
            if (saved) {
              // Replace optimistic with real DB record (has real UUID, survives refresh)
              setMessages(prev => {
                const n = prev.map(m => m.id === optId ? saved : m)
                _cachedMessages[convId] = n
                return n
              })
              touchConversation(convId, payContent, user.id, 'payment_sent')
            } else {
              console.error('[Chat] ✗ Payment card persist failed — optimistic shown for this session only')
              // optimistic stays visible in current session but won't survive refresh
            }
          }).catch(e => console.error('[Chat] ✗ persistMessage threw:', e))
        }
      } catch (e) {
        console.error('[Chat] ✗ Payment message block threw:', e)
      }

      // Paying someone in chat is exactly the "return pay" signal that should
      // save them as a real contact — dedup-safe (never creates duplicates),
      // and also clears any previous "removed" flag since paying them again
      // is an explicit re-add signal.
      if (user?.id && otherUser?.id) {
        import('@/lib/supabase').then(({ upsertContactDb }) => upsertContactDb(user.id!, otherUser.id))
        import('@/lib/removedContacts').then(({ removeFromRemovedContacts }) => {
          removeFromRemovedContacts(useAuthStore.getState().walletAddress, otherUser.id)
        })
      }

      setElapsedSeconds(((performance.now() - payStartRef.current) / 1000).toFixed(2))
      setPayStep('success')
      setPayPassEntry('')
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || 'Payment failed'
      console.error('[Chat] Payment failed:', msg)
      setPayError(msg)
      setPayStep('form')
    } finally {
      chatPayInFlightRef.current = false
    }
  }

  // Only block with a spinner on a conversation that's NEVER been opened
  // before on this device (no cached messages, no cached identity). Once
  // there's anything cached, render it instantly and let the background
  // fetch in setupConversation() silently refresh it — `loading` staying
  // true during that refresh should never re-block the UI that's already
  // showing real content.
  // ── Real, dynamic viewport height — the actual fix for keyboard handling ──
  // 100dvh does NOT reliably shrink when the mobile software keyboard opens
  // (browser support/behavior for this varies widely) — VisualViewport.height
  // does, on every platform that has a keyboard at all (Android Chrome, iOS
  // Safari). Desktop/no-keyboard environments fall back to window.innerHeight
  // via the resize event. Feeding this real, current pixel height directly
  // into the root container's height means flexbox (header flex-shrink-0,
  // messages flex-1, composer flex-shrink-0) does ALL the space-splitting
  // math itself, automatically, every time — no hardcoded padding, no manual
  // keyboard-height guessing, no per-device tuning. The composer's actual
  // rendered height (which already grows/shrinks naturally with multi-line
  // text, attachments, reply previews, etc., since it's a normal DOM flex
  // child) is inherently accounted for by the same mechanism, for free.
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
  const hasSettledInitialHeightRef = useRef(false)
  useEffect(() => {
    const vv = window.visualViewport
    let isFirstCall = true
    const update = () => {
      setViewportHeight(vv ? vv.height : window.innerHeight)
      if (isFirstCall) {
        isFirstCall = false
        // Flip this shortly after — not immediately — so the initial jump
        // from the 100dvh fallback to the real measured height always
        // renders with transition:'none' first. Flipping it right away
        // would apply the transition to that very first jump too, which
        // was the actual bug: the scroll-to-first-unread positioning could
        // then run while the container was still mid-transition,
        // measuring a temporary/wrong size and landing the scroll past the
        // unread content entirely.
        setTimeout(() => { hasSettledInitialHeightRef.current = true }, 200)
      }
    }
    update()
    if (vv) {
      vv.addEventListener('resize', update)
      vv.addEventListener('scroll', update)
    } else {
      window.addEventListener('resize', update)
    }
    return () => {
      if (vv) {
        vv.removeEventListener('resize', update)
        vv.removeEventListener('scroll', update)
      } else {
        window.removeEventListener('resize', update)
      }
    }
  }, [])

  // Tracks whether the user is currently at/near the bottom — the single
  // source of truth for two related rules: (a) if they were at the bottom
  // right before the keyboard opens/closes, keep the latest message
  // anchored above the composer through the resize; (b) if a new message
  // arrives while they're scrolled up reading history, never force-scroll
  // them away from what they're reading — matching WhatsApp exactly.
  const wasNearBottomRef = useRef(true)
  const NEAR_BOTTOM_PX = 120
  // "Scroll to newest" button (shown once you're a screen up) and how many
  // messages arrived below while you were up there.
  const [showJump, setShowJump] = useState(false)
  // "typing…": a light realtime broadcast between the two people in this
  // chat (nothing stored). Sent at most every 2.5s while typing; shown for 4s.
  const [otherTyping, setOtherTyping] = useState(false)
  const typingChannelRef = useRef<any>(null)
  const lastTypingSentRef = useRef(0)
  useEffect(() => {
    if (!conversationId || !user?.id) return
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    let ch: any = null
    let cancelled = false
    import('@/lib/supabase').then(({ supabase }) => {
      if (cancelled) return
      ch = supabase.channel(`typing-${conversationId}`, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'typing' }, (p: any) => {
          if (p?.payload?.from === user.id) return
          setOtherTyping(true)
          if (hideTimer) clearTimeout(hideTimer)
          hideTimer = setTimeout(() => setOtherTyping(false), 4000)
        })
        .subscribe()
      typingChannelRef.current = ch
    })
    return () => {
      cancelled = true
      if (hideTimer) clearTimeout(hideTimer)
      setOtherTyping(false)
      typingChannelRef.current = null
      ch?.unsubscribe?.()
    }
  }, [conversationId, user?.id])
  const notifyTyping = () => {
    const now = Date.now()
    if (now - lastTypingSentRef.current < 2500 || !typingChannelRef.current) return
    lastTypingSentRef.current = now
    typingChannelRef.current.send({ type: 'broadcast', event: 'typing', payload: { from: user?.id } }).catch?.(() => {})
  }
  const [newBelow, setNewBelow] = useState(0)
  const updateNearBottom = () => {
    const el = messagesAreaRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    wasNearBottomRef.current = dist < NEAR_BOTTOM_PX
    setShowJump(dist > 320)
    if (dist < NEAR_BOTTOM_PX) setNewBelow(0)
  }

  // ── Scroll anchoring (no jumps) ─────────────────────────────────────────
  // Whenever anything in the list changes height — older messages added on
  // top, a photo / payment card / link preview finishing loading, the typing
  // line — the message at the top of the screen is kept at exactly the same
  // spot (or, at the bottom, the view stays at the bottom). The correction
  // runs in the ResizeObserver callback, which comes after layout but before
  // paint, so no shifted frame is ever drawn.
  const contentRef = useRef<HTMLDivElement>(null)
  // Browsers with built-in scroll anchoring (Chrome / Android, Firefox) keep
  // the view steady themselves — and without stopping a fling mid-way. Only
  // where it's missing (Safari) do we correct by hand.
  const nativeAnchor = useMemo(() => { try { return CSS.supports('overflow-anchor', 'auto') } catch { return false } }, [])
  const anchorRef = useRef<{ id: string; offset: number } | null>(null)
  const captureAnchor = () => {
    const el = messagesAreaRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const nodes = el.querySelectorAll<HTMLElement>('[data-mid]')
    // Binary search: first message whose bottom is below the top edge.
    let lo = 0, hi = nodes.length - 1, found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (nodes[mid].getBoundingClientRect().bottom > top + 1) { found = mid; hi = mid - 1 } else lo = mid + 1
    }
    if (found < 0) { anchorRef.current = null; return }
    const n = nodes[found]
    anchorRef.current = { id: n.dataset.mid!, offset: n.getBoundingClientRect().top - top }
  }
  const anchorRaf = useRef(0)
  const captureAnchorSoon = () => {
    if (anchorRaf.current) return
    anchorRaf.current = requestAnimationFrame(() => { anchorRaf.current = 0; captureAnchor() })
  }
  const keepAnchor = () => {
    const el = messagesAreaRef.current
    // Until the chat has been positioned (bottom, or the unread divider),
    // the opening code owns the scroll position.
    if (!el || !hasPositionedInitialScrollRef.current) return
    if (wasNearBottomRef.current) { el.scrollTop = el.scrollHeight; return }
    if (nativeAnchor) return
    const a = anchorRef.current
    if (!a) return
    const n = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(a.id)}"]`)
    if (!n) return
    const delta = (n.getBoundingClientRect().top - el.getBoundingClientRect().top) - a.offset
    if (Math.abs(delta) >= 1) el.scrollTop += delta
  }
  const keepAnchorRef = useRef(keepAnchor)
  keepAnchorRef.current = keepAnchor
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => keepAnchorRef.current())
    ro.observe(content)
    return () => ro.disconnect()
  }, [messagesReady])
  // Messages added / removed: correct in the same frame, before paint.
  useLayoutEffect(() => { if (hasPositionedInitialScrollRef.current) keepAnchorRef.current() }, [messages])

  // Decrypt every loaded message up front (one batch), so albums, search and
  // previews know what each message is before it's drawn — no regrouping
  // jump later. Bubbles read the same cache.
  const [, setDecryptTick] = useState(0)
  useEffect(() => {
    if (!convKey) return
    const todo = messages.filter(m => isEncryptedPayload(m.content) && !_plainByContent.has(m.content))
    if (!todo.length) return
    let cancelled = false
    Promise.all(todo.map(m => decryptText(m.content, convKey).then(d => { if (!isDecryptFailure(d)) _plainByContent.set(m.content, d) }).catch(() => {})))
      .then(() => {
        if (cancelled) return
        setDecryptTick(t => t + 1)
        if (wasNearBottomRef.current) requestAnimationFrame(() => { const el = messagesAreaRef.current; if (el) el.scrollTop = el.scrollHeight })
      })
    return () => { cancelled = true }
  }, [messages, convKey])

  // Images (and decrypted images) load after the view is positioned and grow
  // the list — which used to leave the chat opening short of the bottom. If
  // you were at the bottom, stay there as each one loads. ('load' doesn't
  // bubble, so it's caught on the way down.)
  useEffect(() => {
    const el = messagesAreaRef.current
    if (!el) return
    const onLoad = (e: Event) => {
      if ((e.target as HTMLElement)?.tagName !== 'IMG') return
      if (wasNearBottomRef.current) el.scrollTop = el.scrollHeight
    }
    el.addEventListener('load', onLoad, true)
    return () => el.removeEventListener('load', onLoad, true)
  })

  // Re-anchor to the latest message across a viewport height change (keyboard
  // open/close) ONLY if the user was already at the bottom beforehand —
  // otherwise leave their scroll position alone so reading history is never
  // interrupted by the keyboard toggling.
  const prevViewportHeightRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (viewportHeight === null) return
    const changed = prevViewportHeightRef.current !== null && prevViewportHeightRef.current !== viewportHeight
    prevViewportHeightRef.current = viewportHeight
    if (changed && wasNearBottomRef.current) {
      const el = messagesAreaRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [viewportHeight])

  if (loading && messages.length === 0 && !otherUser) {
    return (
      <div className="flex flex-col flex-1 bg-bg items-center justify-center" style={{minHeight:0}}>
        <div className="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }


  return (
    <div className="flex flex-col bg-bg" style={{
      position: 'relative',
      // Desktop: no on-screen keyboard to react to, and this panel lives
      // inside ChatDesktopSplit's right column — NOT the full browser
      // viewport (that column is already shorter than window.innerHeight
      // by DesktopHeader's 68px). Using the mobile visualViewport-tracked
      // pixel height here made this panel taller than its actual
      // container, and the overflow got clipped by that column's own
      // overflow:hidden — which is what was making the header and
      // composer look like they were "hiding": they weren't hiding, this
      // whole panel just didn't fit in the space it was given. height:
      // '100%' simply fills that column instead.
      height: isDesktop ? '100%' : (viewportHeight ? `${viewportHeight}px` : '100dvh'),
      maxHeight: isDesktop ? '100%' : (viewportHeight ? `${viewportHeight}px` : '100dvh'),
      overflow: 'hidden',
      // Smooth, not instant — requirement #3 ("restore smoothly" on keyboard
      // close). Keyboard-open transitions happen fast enough that this
      // reads as responsive, not laggy, while keyboard-close gets a real
      // eased transition instead of an abrupt snap.
      //
      // Only applies AFTER the first real measurement — this transition
      // was also firing on the very first jump from the 100dvh fallback to
      // the real measured pixel height, which meant the initial
      // scroll-to-first-unread positioning could run while the container
      // was still mid-animation, measuring a temporary/wrong size and
      // landing the scroll position past the unread content entirely
      // (only revealed by manually scrolling up) — exactly this bug.
      // Desktop never animates its height at all (no keyboard, so no
      // height changes to smooth over — '100%' is stable).
      transition: isDesktop ? 'none' : (hasSettledInitialHeightRef.current ? 'height 0.15s ease-out' : 'none'),
    }}>
      {/* Wallpaper — a sibling of the scrollable messages area (not a child
          of it), pinned via position:absolute to this whole conversation
          panel. WhatsApp/Telegram's chat background never moves as you
          scroll message history — only the bubbles scroll, the wallpaper
          stays put. Putting it inside the scrollable container (the
          earlier approach) can't guarantee that; living outside it here
          means it structurally cannot scroll — there's no scroll container
          between it and this panel. Header is opaque and paints over it;
          the messages area below has no background of its own, so the
          wallpaper shows through in the gaps between bubbles. */}
      <ChatWallpaper />
      {/* Header */}
      <div className="header-row sticky top-0 gap-3 px-4 pt-header pb-3 flex-shrink-0 bg-bg z-10">
        {selecting ? (
          <>
            <button onClick={clearSelection} className="back-btn" aria-label="Cancel selection">
              <X className="w-5 h-5 text-text-primary" />
            </button>
            <p className="flex-1 text-[18px] font-semibold text-text-primary">{selectedList.length}</p>
            {selectedList.length === 1 && !selDeleted && (
              <button onClick={() => { startReply(selectedList[0]); clearSelection() }} aria-label="Reply" title="Reply" className="w-10 h-10 flex items-center justify-center rounded-full active:opacity-60">
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 016 6v4" /></svg>
              </button>
            )}
            {canCopy && (
              <button onClick={copySelected} aria-label="Copy" title="Copy" className="w-10 h-10 flex items-center justify-center rounded-full active:opacity-60">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></svg>
              </button>
            )}
            {canForward && (
              <button onClick={() => setForwardMsgs(selectedList)} aria-label="Forward" title="Forward" className="w-10 h-10 flex items-center justify-center rounded-full active:opacity-60">
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 00-6 6v4" /></svg>
              </button>
            )}
            <button onClick={() => setDeleteTargets(selectedList)} aria-label="Delete" title="Delete" className="w-10 h-10 flex items-center justify-center rounded-full active:opacity-60">
              <Trash2 className="w-5 h-5 text-text-primary" />
            </button>
            {canInfo && (
              <button onClick={() => { setInfoMsg(selectedList[0]); clearSelection() }} aria-label="Message info" title="Info" className="w-10 h-10 flex items-center justify-center rounded-full active:opacity-60">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></svg>
              </button>
            )}
          </>
        ) : msgSearchOpen ? (
          <>
            <button onClick={closeMsgSearch} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
            <div className="flex-1 flex items-center gap-2 rounded-full px-3.5 h-10 min-w-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
              <Search className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />
              <input
                autoFocus
                value={msgSearchQuery}
                onChange={e => setMsgSearchQuery(e.target.value)}
                placeholder="Search in conversation..."
                className="flex-1 min-w-0 bg-transparent text-text-primary text-sm focus:outline-none placeholder-text-muted"
              />
              {msgSearchQuery && (
                <button onClick={() => setMsgSearchQuery('')} className="flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              )}
            </div>
            {msgSearchQuery.trim() && (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <span className="text-[11px] mr-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {msgSearchMatches.length > 0 ? `${msgSearchIndex + 1}/${msgSearchMatches.length}` : '0/0'}
                </span>
                <button disabled={msgSearchMatches.length === 0}
                  onClick={() => setMsgSearchIndex(i => (i - 1 + msgSearchMatches.length) % msgSearchMatches.length)}
                  className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-30 flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
                </button>
                <button disabled={msgSearchMatches.length === 0}
                  onClick={() => setMsgSearchIndex(i => (i + 1) % msgSearchMatches.length)}
                  className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-30 flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {!isDesktop && (
              <button onClick={() => (location.key !== 'default' ? navigate(-1) : navigate('/chat', { replace: true }))} className="back-btn">
                <ArrowLeft className="w-5 h-5 text-text-primary" />
              </button>
            )}
            <button onClick={() => setShowProfile(true)} className="flex items-center gap-3 flex-1 min-w-0 active:opacity-70 transition-opacity">
              <Avatar name={otherUser?.display_name ?? ""} src={otherUser?.avatar_url ?? null} size="sm" className="!w-[38px] !h-[38px] self-center flex-shrink-0" />
              <div className="min-w-0 flex flex-col justify-center text-left">
                <p className="text-[14px] font-semibold text-text-primary leading-tight truncate flex items-center gap-1">
                  {otherUser?.display_name ?? ""}
                  
                </p>
                {otherTyping
                  ? <p className="text-[12px] leading-tight" style={{ color: 'var(--success)' }}>typing…</p>
                  : <p className="text-[12px] text-link leading-tight">{recipientClean}.arc</p>}
              </div>
            </button>
            <button onClick={() => setMsgSearchOpen(true)}
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}
              title="Search in conversation" aria-label="Search in conversation">
              <Search className="w-4 h-4 text-text-primary" />
            </button>
            <button onClick={handlePay} type="button"
              className="text-white flex items-center gap-1.5 justify-center flex-shrink-0 active:scale-90 transition-transform"
              title="Pay" aria-label="Pay"
              style={{ height: '38px', width: '79px', borderRadius: '14px', padding: '0 11px', background: 'var(--brand)' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 12h8M13 8l4 4-4 4"/>
              </svg>
              <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '-0.2px' }}>Pay</span>
            </button>
          </>
        )}
      </div>

      {/* Open bills / payment requests between the two of us — both sides. */}
      {!msgSearchOpen && otherUser?.id && otherUser.id !== user?.id && (
        <ChatPendingOrders otherUserId={otherUser.id} refreshKey={messages.length} />
      )}

      {/* Scrollable conversation area - tap to hide keyboard. No background
          of its own (transparent) so the fixed ChatWallpaper sibling above
          shows through in the gaps between message bubbles. */}
      <div ref={messagesAreaRef} className="flex-1 overflow-y-auto px-2 pt-2 pb-2 relative"
        // Scroll anchoring: the browser's own where it has one, ours otherwise
        // (keepAnchor). No stretch / bounce at the ends.
        style={{ visibility: messagesReady ? 'visible' : 'hidden', overflowAnchor: nativeAnchor ? 'auto' : 'none', overscrollBehaviorY: 'none' }}
        onClick={() => { if (isKeyboardOpen.current) messageInputRef.current?.blur() }}
        onTouchStart={() => { if (isKeyboardOpen.current) messageInputRef.current?.blur() }}
        onScroll={(e) => {
          const el = e.currentTarget
          updateNearBottom()
          captureAnchorSoon()
          // Fetch older messages well before the top is reached (a screen
          // ahead), so scrolling up never stops at an empty edge.
          if (el.scrollTop > Math.max(600, el.clientHeight * 1.5) || loadingOlder || !hasMoreHistory || !conversationId || messages.length === 0) return
          setLoadingOlder(true)
          const oldestCreatedAt = messages[0].created_at
          loadOlderMessages(conversationId, oldestCreatedAt).then(async older => {
            if (older.length === 0) { setHasMoreHistory(false); setLoadingOlder(false); return }
            // Decrypt first, so each bubble appears at its final size (an empty
            // bubble filling in a moment later is what made history jump).
            if (convKey) {
              await Promise.all(older.filter(m => isEncryptedPayload(m.content) && !_plainByContent.has(m.content))
                .map(m => decryptText(m.content, convKey).then(d => { if (!isDecryptFailure(d)) _plainByContent.set(m.content, d) }).catch(() => {})))
            }
            if (older.length < 50) setHasMoreHistory(false)
            setMessages(prev => {
              const seen = new Set(prev.map(m => m.id))
              const merged = [...older.filter(m => !seen.has(m.id)), ...prev]
              _cachedMessages[conversationId] = merged
              return filterDeleted(merged)
            })
            // The message you're looking at stays exactly where it is: the
            // content resize is caught before paint and corrected (keepAnchor).
            setLoadingOlder(false)
          })
        }}>
        {loadingOlder && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        <div ref={contentRef}>
        {messages.length === 0 && (
          <div className="text-center py-12">
            <Avatar name={otherUser?.display_name ?? ""} src={otherUser?.avatar_url ?? null} size="xl" className="mx-auto mb-3" />
            <UsernameDisplay username={otherUser?.username ?? ""} size="lg" className="justify-center mb-1" />
            <p className="text-sm text-text-secondary mt-2">Send a message or USDC to get started!</p>
          </div>
        )}

        {(() => {
          // Deduplicate messages for display
          const seenIds = new Set<string>()
          const seenContent = new Set<string>()
          const seenTxHash = new Set<string>()
          // SELF-TRANSFER: see the identical comment on the Realtime handler
          // above — both the 'payment_sent' and 'payment_received' rows for a
          // self-payment carry sender_id === user.id, so the plain sender_id
          // check below can't distinguish them here either. Always drop the
          // 'payment_received' echo in a self-chat so only the single 'Sent'
          // card renders, never both.
          const isSelfChat = !!(user?.id && otherUser?.id && otherUser.id === user.id)
          const dedupedMsgs = messages.filter(msg => {
            // Drop payment_received rows that belong to the other person (echo rows we shouldn't see)
            if (msg.type === 'payment_received' && (isSelfChat || msg.sender_id !== user!.id)) return false
            // Drop payment_sent rows that the current user didn't send
            // (receiver sees only the payment_received row, not the sender's payment_sent row)
            if (msg.type === 'payment_sent' && msg.sender_id !== user!.id) return false
            if (seenIds.has(msg.id)) return false
            seenIds.add(msg.id)
            // Dedup payment cards by tx hash first — it's stable across the
            // optimistic → realtime-echo → persisted lifecycle of the same
            // transaction, even when ids/timestamps differ between those copies.
            if ((msg.type === 'payment_sent' || msg.type === 'payment_received') && msg.payment_tx_hash) {
              if (seenTxHash.has(msg.payment_tx_hash)) return false
              seenTxHash.add(msg.payment_tx_hash)
            }
            // Dedup by content+type within same second (removes true DB duplicates only)
            const second = new Date(msg.created_at).toISOString().slice(0, 19)
            // Content is part of the key deliberately — type+payment_amount
            // alone are identical for every text message ('text'/null), so
            // without this, two DIFFERENT messages from the same sender
            // landing in the same second (easy to hit when typing quickly,
            // e.g. rapid test messages) would collide and the second one
            // would be silently dropped as a false-positive duplicate, even
            // though it's real, distinct content that was never actually
            // duplicated server-side.
            const key = `${msg.sender_id}|${msg.type}|${msg.payment_amount}|${second}|${msg.content}`
            if (seenContent.has(key)) return false
            seenContent.add(key)
            return true
          })
          // Find where the divider actually belongs in the list that
          // survived dedup — matching by created_at rather than requiring
          // the original anchor message's exact id to still be present,
          // since dedup above can legitimately drop that exact row (echo
          // payment cards, content-based duplicates) while an adjacent
          // message effectively represents the same "here's where you left
          // off" point. Shows for any unread message, including a single one.
          const unreadDividerMsgId = (unreadCountRef.current >= 1 && firstUnreadAtRef.current)
            ? dedupedMsgs.find(m => m.created_at >= firstUnreadAtRef.current!)?.id ?? null
            : null
          // Groups (WhatsApp): photos sent together → one album; files /
          // documents sent together → one bubble. Items picked together carry
          // the same batch id; older ones group by sender within a minute.
          const mediaInfo = (m: any) => {
            if (m.type !== 'text' || m.content === '[deleted]' || m.reply_to_id || m.forwarded) return null
            const md = parseMedia(plainTextOf(m.content) || m.content)
            return md ? { kind: md.kind, g: metaOf(md.url).g } : null
          }
          const albumOf: Record<string, any[]> = {}
          const fileGroupOf: Record<string, any[]> = {}
          const inAlbum = new Set<string>()
          {
            let run: any[] = []
            let runInfo: { kind: string; g?: string } | null = null
            const flush = () => {
              if (run.length >= 2 && runInfo) {
                if (runInfo.kind === 'image') albumOf[run[0].id] = run; else fileGroupOf[run[0].id] = run
                run.slice(1).forEach(m => inAlbum.add(m.id))
              }
              run = []; runInfo = null
            }
            for (const m of dedupedMsgs) {
              const info = mediaInfo(m)
              const last = run[run.length - 1]
              const joins = !!(info && last && runInfo && last.sender_id === m.sender_id && info.kind === runInfo.kind
                && (info.g || runInfo.g
                  ? info.g === runInfo.g
                  : new Date(m.created_at).getTime() - new Date(last.created_at).getTime() < 60_000
                    && new Date(m.created_at).toDateString() === new Date(last.created_at).toDateString()))
              if (joins) run.push(m)
              else { flush(); if (info) { run = [m]; runInfo = info } }
            }
            flush()
          }
          return dedupedMsgs.map((msg, i, arr) => {
            if (inAlbum.has(msg.id)) return null
            const isMine    = msg.type === 'payment_received' ? false : msg.sender_id === user!.id
            const isPayment = msg.type === 'payment_sent' || msg.type === 'payment_received'
            const prevMsg   = arr[i - 1]
            const nextMsg   = arr[i + 1]
            const timeDiff  = prevMsg ? new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() : Infinity
            // Date divider: show only when calendar DAY changes (not just 5-min gap)
            const msgDay    = new Date(msg.created_at).toDateString()
            const prevDay   = prevMsg ? new Date(prevMsg.created_at).toDateString() : null
            const showTime  = i === 0 || msgDay !== prevDay
            const isFirstInGroup = !prevMsg || prevMsg.sender_id !== msg.sender_id || timeDiff > 2 * 60 * 1000 || showTime
            const isLastInGroup  = !nextMsg || nextMsg.sender_id !== msg.sender_id ||
              new Date(nextMsg.created_at).getTime() - new Date(msg.created_at).getTime() > 2 * 60 * 1000
            const isCurrentMatch = msgSearchQuery.trim() && msgSearchMatches[msgSearchIndex] === msg.id
            return (
              <Fragment key={msg.id}>
                <AnimatePresence>
                  {msg.id === unreadDividerMsgId && !dividerDismissed && <UnreadDivider count={unreadCountRef.current} />}
                </AnimatePresence>
                {(albumOf[msg.id] || fileGroupOf[msg.id]) ? ((() => {
                    const group = albumOf[msg.id] || fileGroupOf[msg.id]
                    const selectAll = (g: any[]) => { justLongPressedRef.current = Date.now(); setSelected(prev => { const n = { ...prev }; g.forEach(m => { n[m.id] = { ...m, isMine } }); return n }) }
                    return (
                    <>
                      {showTime && <DateSeparator iso={msg.created_at} />}
                      <div data-mid={msg.id} ref={el => { group.forEach(m => { messageRefs.current[m.id] = el }) }}
                        style={group.some(m => selected[m.id]) ? { background: 'color-mix(in srgb, var(--brand) 24%, transparent)', margin: '0 -8px', padding: '0 8px' } : undefined}
                        onClickCapture={selecting ? (e) => {
                          e.stopPropagation(); e.preventDefault()
                          if (Date.now() - justLongPressedRef.current < 450) return
                          const allOn = group.every(m => selected[m.id])
                          setSelected(prev => { const n = { ...prev }; group.forEach(m => { if (allOn) delete n[m.id]; else n[m.id] = { ...m, isMine } }); return n })
                        } : undefined}>
                        {albumOf[msg.id] ? (
                          <AlbumBubble msgs={group} isMine={isMine} convKey={convKey} selecting={selecting}
                            onOpen={mid => setViewerStartId(mid)}
                            onSelectAll={selectAll}
                            onCancelUpload={cancelUpload} onRetry={retryMessage} />
                        ) : (
                          <FileGroupBubble msgs={group} isMine={isMine} convKey={convKey}
                            onOpenImage={handleImageTap} onSelectAll={selectAll}
                            onCancelUpload={cancelUpload} onRetry={retryMessage} />
                        )}
                      </div>
                    </>
                    )
                  })()
                ) : (
                <div data-mid={msg.id}
                  ref={el => { messageRefs.current[msg.id] = el }}
                  onClickCapture={selecting ? (e) => { e.stopPropagation(); e.preventDefault(); toggleSelected(msg, isMine) } : undefined}
                  style={selected[msg.id]
                    ? { background: 'color-mix(in srgb, var(--brand) 24%, transparent)', margin: '0 -8px', padding: '0 8px', transition: 'background 0.15s' }
                    : isCurrentMatch ? { background: 'color-mix(in srgb, var(--brand) 15%, transparent)', borderRadius: 14, transition: 'background 0.3s' } : undefined}>
                  <MessageBubble
                    msg={msg}
                    isMine={isMine}
                    isPayment={isPayment}
                    showTime={showTime}
                    isFirstInGroup={isFirstInGroup}
                    isLastInGroup={isLastInGroup}
                    recipientClean={recipientClean}
                    userId={user!.id}
                    onImageTap={handleImageTap}
                    onLongPress={startMsgLongPress}
                    onLongPressEnd={cancelMsgLongPress}
                    convKey={convKey}
                    onRetry={retryMessage}
                    onReply={selecting ? undefined : startReply}
                    getMsg={getMsgById}
                    onJumpTo={jumpToMessage}
                    otherName={otherUser?.display_name || undefined}
                    onCancelUpload={cancelUpload}
                  />
                </div>
                )}
              </Fragment>
            )
          })
        })()}
        <div ref={messagesEndRef} style={{ height: 4 }} />
        </div>
      </div>

      {/* Composer — sticky above home indicator */}
      {/* ── Message input bar ───────────────────────────────────────────────── */}
      <div className="border-t border-border bg-bg flex-shrink-0 relative"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <AnimatePresence>
          {showJump && (
            <motion.button key="jump" type="button" aria-label={newBelow ? `Scroll to newest, ${newBelow} new` : 'Scroll to newest'}
              initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.15 }}
              onClick={() => { setNewBelow(0); scrollToBottom() }}
              style={{ position: 'absolute', right: 14, bottom: 'calc(100% + 12px)', width: 42, height: 42, borderRadius: '50%', border: '1px solid var(--border)',
                background: 'var(--surface)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(0,0,0,0.3)', zIndex: 5, cursor: 'pointer' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              {newBelow > 0 && (
                <span style={{ position: 'absolute', top: -6, right: -4, minWidth: 20, height: 20, borderRadius: 10, background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px', boxSizing: 'border-box' }}>{newBelow > 99 ? '99+' : newBelow}</span>
              )}
            </motion.button>
          )}
        </AnimatePresence>

        {/* Replying to… (swipe-to-reply) */}
        <AnimatePresence>
          {replyTo && (
            <motion.div key="replybar" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.15 }}
              style={{ overflow: 'hidden' }}>
              <div className="flex items-center gap-2 mx-3 mt-2 rounded-xl px-3 py-2"
                style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', borderLeft: `4px solid ${replyTo.sender_id === user?.id ? 'var(--link)' : '#e7a36b'}` }}>
                <div className="flex-1 min-w-0">
                  <QuoteBody quoted={replyTo} convKey={convKey}
                    name={replyTo.sender_id === user?.id ? 'You' : (otherUser?.display_name || recipientClean)}
                    nameColor={replyTo.sender_id === user?.id ? 'var(--link)' : '#e7a36b'} textColor="var(--text-secondary)" />
                </div>
                <button onClick={() => setReplyTo(null)} aria-label="Cancel reply" className="w-8 h-8 flex items-center justify-center rounded-full">
                  <X className="w-4 h-4 text-text-secondary" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pending file previews */}
        <AnimatePresence>
          {pendingFiles.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="px-4 pt-3 pb-1 flex gap-2 overflow-x-auto">
              {pendingFiles.map(pf => (
                <div key={pf.id} className="relative flex-shrink-0">
                  {pf.isImage && pf.previewUrl ? (
                    <img src={pf.previewUrl} alt={pf.file.name}
                      className="w-16 h-16 rounded-xl object-cover border border-border" />
                  ) : (
                    <div className="w-16 h-16 rounded-xl bg-surface border border-border flex flex-col items-center justify-center px-1">
                      <File className="w-5 h-5 text-brand" />
                      <span className="text-[8px] text-text-secondary truncate max-w-full mt-0.5">{pf.file.name}</span>
                    </div>
                  )}
                  <button onClick={() => removePendingFile(pf.id)} type="button"
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center shadow-md active:scale-90 transition-transform">
                    <X className="w-3 h-3" />
                  </button>
                  {uploadProgress && (
                    <div className="absolute inset-0 rounded-xl bg-black/50 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 text-white animate-spin" />
                    </div>
                  )}
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input row — attach | textarea | send */}
        <div className="px-3 pt-2.5 pb-2 flex items-end gap-2">
          {/* Attach button */}
          <button onClick={() => setShowAttach(true)} type="button"
            className="w-9 h-9 mb-1 rounded-full flex items-center justify-center text-text-secondary active:text-text-primary active:bg-[rgb(var(--text-primary-rgb)/0.10)] flex-shrink-0 transition-colors">
            <Paperclip className="w-6 h-6" />
          </button>

          {/* Text input box */}
          <div className="flex-1 flex items-end gap-2 bg-surface border border-border rounded-3xl px-3.5 py-3 min-h-[48px]">
            <textarea
              ref={messageInputRef}
              value={messageText}
              rows={1}
              onChange={e => { setMessageText(e.target.value); autoResize(); if (e.target.value) notifyTyping() }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder={`Message ${recipientClean}.arc`}
              className="flex-1 bg-transparent text-text-primary placeholder-text-secondary text-[15px] focus:outline-none resize-none leading-[22px] max-h-[110px] transition-[height] duration-150"
              style={{ height: '22px', minHeight: '22px' }}
            />
          </div>

          {/* Send button — +15% again (39.6px -> 45.5px), icon scaled to
              keep the same ~50% fill proportion. Nothing else resized. */}
          <button
            onClick={() => handleSend()}
            disabled={(!messageText.trim() && pendingFiles.length === 0) || sending}
            type="button"
            className="mb-1 rounded-full bg-brand-gradient text-white disabled:opacity-40 flex items-center justify-center flex-shrink-0 active:scale-90 transition-transform"
            style={{ width: 45.5, height: 45.5 }}>
            {sending
              ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>
                </svg>}
          </button>
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={handleFileUpload} />

      <Sheet isOpen={showAttach} onClose={() => setShowAttach(false)} title="Send Attachment">
        <div className="px-5 py-4 space-y-3">
          {[
            { icon: <Image className="w-6 h-6 text-accent-text" />, label: 'Image', sub: 'Photo or image', color: 'bg-accent/20' },
            { icon: <FileText className="w-6 h-6 text-brand" />, label: 'Document', sub: 'PDF, Word, Excel', color: 'bg-brand/20' },
            { icon: <File className="w-6 h-6 text-warning" />, label: 'File', sub: 'Any file type', color: 'bg-warning/20' },
            ...(merchant.isMerchant ? [{ icon: <Receipt className="w-6 h-6 text-success" />, label: 'Bill', sub: 'Products, quantity & price — customer pays in chat', color: 'bg-success/20' }] : []),
          ].map(item => (
            <button key={item.label} onClick={() => {
                if (item.label === 'Bill') { setShowAttach(false); setTimeout(() => setShowBill(true), 300); return }
                const accept = item.label === 'Image' ? 'image/*' : item.label === 'Document' ? 'application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt' : '*/*'
                pickModeRef.current = item.label === 'Image' ? 'image' : item.label === 'Document' ? 'document' : 'file'
                setShowAttach(false)
                setTimeout(() => {
                  if (fileInputRef.current) { fileInputRef.current.accept = accept; fileInputRef.current.value = ''; fileInputRef.current.click() }
                }, 300)
              }}
              className="w-full flex items-center gap-4 p-4 bg-surface border border-border rounded-2xl active:scale-95 transition-transform">
              <div className={`w-12 h-12 ${item.color} rounded-xl flex items-center justify-center flex-shrink-0`}>{item.icon}</div>
              <div className="text-left">
                <p className="text-text-primary font-semibold">{item.label}</p>
                <p className="text-sm text-text-secondary">{item.sub}</p>
              </div>
            </button>
          ))}
        </div>
      </Sheet>

      {merchant.isMerchant && (
        <Sheet isOpen={showBill} onClose={() => setShowBill(false)} title="New bill">
          {showBill && (
            <InvoiceComposer
              merchantName={merchant.application?.businessName}
              customerUsername={otherUser?.username ?? null}
              onCancel={() => setShowBill(false)}
              onSend={async inv => {
                const lines = (inv.items ?? []).map(i => `${i.name} × ${i.qty}`).join(', ')
                await handleSend(`🧾 Bill · Order #${orderLabel(inv)} · $${formatAmount(inv.amount)} USDC${lines ? `\n${lines}` : ''}${inv.note ? `\n${inv.note}` : ''}\n${paymentLink(inv.code)}`)
                setShowBill(false)
              }}
            />
          )}
        </Sheet>
      )}

      {/* ── User Profile Sheet / Dialog ────────────────────────────────── */}
      <AnimatePresence>
        {showProfile && (() => {
          const profileContent = (
            <>
              {/* Avatar + name */}
              <div className="flex flex-col items-center pt-4 pb-5 px-6">
                <Avatar name={otherUser?.display_name ?? ""} src={otherUser?.avatar_url ?? null} size="xl" className="!w-[72px] !h-[72px] mb-3" />
                <p className="text-[18px] font-bold text-text-primary flex items-center gap-1.5">
                  {otherUser?.display_name ?? ""}

                </p>
                <p className="text-[13px] text-link mt-0.5">{recipientClean}.arc</p>
                {otherUser.wallet_address && (
                  <p className="text-[11px] text-text-muted mt-1 font-mono">
                    {otherUser?.wallet_address?.slice(0,6)}...{otherUser?.wallet_address?.slice(-6)}
                  </p>
                )}
              </div>

              {/* Stats */}
              <div className="px-5 pb-4 flex gap-3">
                <div className="flex-1 rounded-2xl p-3.5 text-center" style={{ background:'color-mix(in srgb, var(--brand) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--brand) 20%, transparent)' }}>
                  <p className="text-[11px] text-text-secondary mb-1">Total Sent</p>
                  <p className="text-[17px] font-bold text-brand">{formatAmount(totalSent)}</p>
                  <p className="text-[10px] text-text-secondary">USDC</p>
                </div>
                <div className="flex-1 rounded-2xl p-3.5 text-center" style={{ background:'color-mix(in srgb, var(--success) 8%, transparent)', border:'1px solid color-mix(in srgb, var(--success) 20%, transparent)' }}>
                  <p className="text-[11px] text-text-secondary mb-1">Total Received</p>
                  <p className="text-[17px] font-bold text-success">{formatAmount(totalReceived)}</p>
                  <p className="text-[10px] text-text-secondary">USDC</p>
                </div>
              </div>

              {/* Actions */}
              <div className="px-5 space-y-2.5">
                {/* Pay */}
                <button
                  onClick={() => { setShowProfile(false); handlePay() }}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl active:scale-[0.98] transition-transform"
                  style={{ background:'color-mix(in srgb, var(--brand) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--brand) 20%, transparent)' }}>
                  <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:'color-mix(in srgb, var(--brand) 20%, transparent)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M8 12h8M13 8l4 4-4 4"/>
                    </svg>
                  </div>
                  <span className="text-[15px] font-semibold text-text-primary">Pay {recipientClean}.arc</span>
                </button>

                {/* Transaction history */}
                <button
                  onClick={() => { setShowProfile(false); setShowHistory(true) }}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl active:scale-[0.98] transition-transform"
                  style={{ background:'color-mix(in srgb, var(--text-primary) 4%, transparent)', border:'1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                  <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                  </div>
                  <span className="text-[15px] font-semibold text-text-primary">Transaction History</span>
                </button>

                {/* Remove contact */}
                <button
                  onClick={() => {
                    setShowProfile(false)
                    if (conversationId) {
                      const addr = useAuthStore.getState().walletAddress
                      hideChat(conversationId, addr)
                      if (otherUser?.id && addr) {
                        import('@/lib/removedContacts').then(({ addRemovedContact }) => {
                          addRemovedContact(addr, otherUser.id)
                        })
                      }
                      navigate('/chat')
                    }
                  }}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-2xl active:scale-[0.98] transition-transform"
                  style={{ background:'color-mix(in srgb, var(--danger) 6%, transparent)', border:'1px solid color-mix(in srgb, var(--danger) 15%, transparent)' }}>
                  <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background:'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
                    <Trash2 className="w-4 h-4 text-danger" />
                  </div>
                  <span className="text-[15px] font-semibold text-danger">Remove Contact</span>
                </button>
              </div>
            </>
          )
          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setShowProfile(false)} maxWidth={420}>
              <div className="pt-2 pb-6">{profileContent}</div>
            </DesktopDialogFrame>
          ) : (
            <>
              <motion.div transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setShowProfile(false)} />
              <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={SHEET_SPRING}
                className="absolute bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-3xl pb-10">
                {/* Handle */}
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[rgb(var(--text-primary-rgb)/0.20)]" />
                </div>
                {profileContent}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {showHistory && (() => {
          const historyHeader = (
            <div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-border">
              <div>
                <h2 className="text-lg font-bold text-text-primary">Transaction History</h2>
                <p className="text-xs text-text-secondary">With {recipientClean}.arc</p>
              </div>
              <button onClick={() => setShowHistory(false)} className="p-2 rounded-full hover:bg-[rgb(var(--text-primary-rgb)/0.10)] text-text-secondary"><X className="w-5 h-5" /></button>
            </div>
          )
          const historyBody = (
            <>
              <div className="px-5 py-3 flex gap-3 border-b border-border">
                <div className="flex-1 bg-surface rounded-2xl p-3">
                  <p className="text-xs text-text-secondary">Total Paid</p>
                  <p className="text-lg font-bold text-brand">{formatAmount(totalSent)} USDC</p>
                </div>
                <div className="flex-1 bg-surface rounded-2xl p-3">
                  <p className="text-xs text-text-secondary">Total Received</p>
                  <p className="text-lg font-bold text-success">{formatAmount(totalReceived)} USDC</p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
                {paymentHistory.length === 0 ? (
                  <div className="text-center py-12"><p className="text-sm text-text-secondary">No payments yet with {recipientClean}.arc</p></div>
                ) : paymentHistory.map(p => {
                  const sent = p.sender_id === user?.id
                  return (
                    <div key={p.id} className="flex items-center gap-3 bg-surface rounded-2xl p-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${sent ? 'bg-brand/20' : 'bg-success/20'}`}>
                        {sent ? <ArrowUpRight className="w-4 h-4 text-brand" /> : <ArrowDownLeft className="w-4 h-4 text-success" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary">{sent ? 'Paid' : 'Received'}</p>
                        <p className="text-xs text-text-secondary">{new Date(p.created_at).toLocaleDateString([], {month:'short',day:'numeric'}) + ' ' + new Date(p.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${sent ? 'text-brand' : 'text-success'}`}>{sent ? '-' : '+'}{formatAmount(p.payment_amount || 0, chatPayTokenDecimals((p.token_symbol as ChatPayToken) || 'USDC'))} {p.token_symbol || 'USDC'}</p>
                        {p.payment_tx_hash && (
                          <a href={`https://testnet.arcscan.app/tx/${p.payment_tx_hash}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-brand">View →</a>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )
          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setShowHistory(false)} maxWidth={460}>
              <div className="flex flex-col max-h-[80vh]">
                {historyHeader}
                {historyBody}
              </div>
            </DesktopDialogFrame>
          ) : (
            <>
              <motion.div transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={() => setShowHistory(false)} />
              <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={SHEET_SPRING}
                className="absolute bottom-0 left-0 right-0 z-50 bg-bg border-t border-border rounded-t-3xl max-h-[80vh] flex flex-col">
                {historyHeader}
                {historyBody}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      {/* In-Chat Payment Modal — STEP 1: Amount entry form */}
      <AnimatePresence>
        {payStep === 'form' && (() => {
          const formContent = (
              <div className="px-5 pt-4 pb-6 space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={otherUser?.display_name ?? ""} src={otherUser?.avatar_url ?? null} size="sm" />
                    <div>
                      <p className="text-[15px] font-bold text-text-primary">{otherUser?.display_name || recipientClean}</p>
                      <p className="text-[12px] font-mono text-link">{recipientClean}.arc</p>
                    </div>
                  </div>
                </div>

                {billPay && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', borderRadius: 14,
                    background: 'color-mix(in srgb, var(--brand) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Order #{billPay.number}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Amount set by merchant</span>
                  </div>
                )}

                {/* Token selector — USDC / EURC / cirBTC */}
                {linkPay?.amount && !billPay && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', borderRadius: 14,
                    background: 'color-mix(in srgb, var(--brand) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Payment link</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Amount set by {linkPay.username}.arc</span>
                  </div>
                )}

                {!payLocked && <div className="flex gap-2">
                  {payTokenList.map(t => (
                    <button key={t} onClick={() => { setPayToken(t); setPayAmount(''); setPayError('') }}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-2xl transition-all"
                      style={{
                        background: payToken === t ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'var(--surface)',
                        border: payToken === t ? '1px solid var(--brand)' : '1px solid var(--border)',
                        color: payToken === t ? 'var(--brand)' : 'var(--text-secondary)',
                        fontWeight: payToken === t ? 700 : 500, fontSize: 13,
                      }}>
                      <span style={{ width: 18, height: 18, borderRadius: '50%',
                        background: chatPayTokenIconBg(t),
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 700, color: '#fff' }}>
                        {chatPayTokenSymbolChar(t)}
                      </span>
                      {t}
                    </button>
                  ))}
                </div>}

                {/* Amount — mobile taps to reveal the keypad below (unchanged).
                    Desktop uses the same bare-box + overlaid Max pill +
                    Balance row treatment as Multichain Transfer/Swap's own
                    amount box instead of this static display duplicated
                    above a second, separate live input. */}
                {!isDesktop && (
                  <div className="rounded-2xl" style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)', padding: '12px 16px' }}>
                    <div className="flex items-baseline justify-center gap-1 mb-1"
                      onClick={() => { if (!payLocked) setShowAmountPad(v => !v) }}
                      style={{ cursor: payLocked ? 'default' : 'pointer' }}>
                      <span style={{ fontSize: 36, fontWeight: 700, lineHeight: 1, color: payAmount ? 'var(--text-primary)' : 'color-mix(in srgb, var(--text-primary) 20%, transparent)' }}>{chatPayTokenSymbolChar(payToken)}</span>
                      {/* BUG FIX: was a single 28/36 binary step tuned for
                          ~2-decimal USDC/EURC amounts -- an 8-decimal
                          cirBTC amount (up to 10+ chars) could still
                          overflow this row at 28px. Graduated shrink
                          instead. */}
                      <span style={{ fontSize: amountFontSize(payAmount, 36), fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1, minWidth: '1ch', fontFamily: 'monospace' }}>{payAmount || '0'}</span>
                      <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 4 }}>{payToken}</span>
                    </div>
                    <p className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                      Balance {chatPayTokenSymbolChar(payToken)}{formatAmount(payTokenBalanceOf(payToken), chatPayTokenDecimals(payToken))}
                    </p>
                  </div>
                )}

                {isDesktop && (() => {
                  const payTokenBalance = payTokenBalanceOf(payToken)
                  return (
                    <div style={{ position: 'relative' }}>
                      <div style={{
                        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14,
                        padding: '28px 20px', minHeight: 108, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                      }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          autoFocus={!payLocked}
                          readOnly={payLocked}
                          value={payAmount}
                          onChange={e => {
                            if (payLocked) return
                            let cleaned = e.target.value.replace(/[^\d.]/g, '')
                            const firstDot = cleaned.indexOf('.')
                            if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
                            const [intPart, decPart] = cleaned.split('.')
                            // BUG FIX: this used to hardcode a 2-decimal cap
                            // -- fine for USDC/EURC, but cirBTC is 8-decimal
                            // and realistic amounts (0.00025) collapse to
                            // "0.00" at 2 decimals, making cirBTC unusable
                            // here even once selectable.
                            if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, chatPayTokenDecimals(payToken))
                            setPayAmount(cleaned)
                            setPayError('')
                          }}
                          placeholder="0.00"
                          style={{
                            width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
                            // BUG FIX: this was a fixed 34px no matter how
                            // long the typed amount got -- an 8-decimal
                            // cirBTC value would overflow the box instead
                            // of shrinking.
                            fontSize: amountFontSize(payAmount, 34), fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
                            textAlign: 'center',
                          }}
                          aria-label={`Amount in ${payToken}`}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Balance: <span style={{ color: 'var(--success)', fontWeight: 600 }}>{chatPayTokenSymbolChar(payToken)}{formatAmount(payTokenBalance, chatPayTokenDecimals(payToken))} {payToken}</span></span>
                        {payTokenBalance > 0 && !payLocked && (
                          <button
                            onClick={() => { setPayAmount(parseFloat(payTokenBalance.toFixed(chatPayTokenDecimals(payToken))).toString()); setPayError('') }}
                            style={{
                              padding: '5px 14px', borderRadius: 100,
                              border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)',
                              background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand)',
                              fontSize: 12, fontWeight: 700, cursor: 'pointer',
                            }}
                          >
                            Max
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Inline numeric keypad — part of the SAME sheet's normal document
                    flow (no separate position:fixed overlay), so it can never get
                    clipped or stacked behind/under anything else in this sheet.
                    Mobile only — desktop's live input above needs no on-screen grid. */}
                {!isDesktop && showAmountPad && !payLocked && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, maxWidth: 320, margin: '4px auto 0' }}>
                    {['1','2','3','4','5','6','7','8','9','.','0','del'].map((key, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          if (key === 'del') { setPayAmount(v => v.slice(0, -1)); setPayError(''); return }
                          if (key === '.') {
                            if (payAmount.includes('.')) return
                            setPayAmount(v => (v || '0') + '.')
                            setPayError('')
                            return
                          }
                          // BUG FIX: hardcoded 2-decimal cap -- see the
                          // desktop input's own comment above, same issue.
                          if (payAmount.includes('.') && payAmount.split('.')[1].length >= chatPayTokenDecimals(payToken)) return
                          setPayAmount(v => v === '0' ? key : v + key)
                          setPayError('')
                        }}
                        style={{
                          height: 56, borderRadius: 12, width: '100%',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', fontSize: key === '.' ? 28 : 24, fontWeight: 600, color: key === 'del' ? 'var(--text-secondary)' : 'var(--text-primary)',
                        }}
                        onMouseDown={() => { if (key === 'del') startPayDeleteHold() }}
                        onMouseUp={() => { if (key === 'del') stopPayDeleteHold() }}
                        onMouseLeave={() => { if (key === 'del') stopPayDeleteHold() }}
                        onTouchStart={() => { if (key === 'del') startPayDeleteHold() }}
                        onTouchEnd={() => { if (key === 'del') stopPayDeleteHold() }}
                        onTouchCancel={() => { if (key === 'del') stopPayDeleteHold() }}
                      >
                        {key === 'del'
                          ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z"/>
                              <line x1="18" y1="9" x2="12" y2="15"/>
                              <line x1="12" y1="9" x2="18" y2="15"/>
                            </svg>
                          : key}
                      </button>
                    ))}
                  </div>
                )}

                {payError && (
                  <p role="alert" className="text-sm text-danger text-center">{payError}</p>
                )}

                {/* Cancel + Pay buttons */}
                <div className="flex gap-3 pt-1">
                  <button onClick={() => { setPayStep('closed'); setPayAmount(''); setPayError(''); setShowAmountPad(false) }}
                    className="flex-1 py-3.5 rounded-2xl text-[15px] font-semibold active:scale-95 transition-transform"
                    style={{ background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)', color: 'var(--text-secondary)' }}>
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const n = parseFloat(payAmount)
                      if (!n || n <= 0) { setPayError('Enter a valid amount'); return }
                      setShowAmountPad(false)
                      setPayPassEntry('')
                      setPayStep('confirm')
                    }}
                    disabled={!payAmount || parseFloat(payAmount) <= 0}
                    className="flex-1 py-3.5 rounded-2xl text-[15px] font-bold text-white disabled:opacity-40 active:scale-95 transition-transform"
                    style={{ background: 'var(--brand)' }}>
                    Pay
                  </button>
                </div>
              </div>
          )
          const closeForm = () => { setPayStep('closed'); setPayPassEntry(''); setShowAmountPad(false) }
          return isDesktop ? (
            // Not a popup — Chat has no separate page to put the amount
            // step "inline" on like Send/Swap/etc. do, so instead of a
            // centered dialog this slides in from the right edge of the
            // screen, with a light non-blocking dim rather than a heavy
            // modal backdrop, reading as part of this page (like an email
            // compose pane) instead of a dialog floating over it.
            // position:'fixed' (viewport-relative, same mechanism every
            // other dialog in the app already uses) rather than
            // position:'absolute' scoped to the conversation panel — the
            // panel-scoped version was found to visibly drag the whole
            // conversation column sideways when this animated in, so this
            // is pinned to the viewport instead and simply positioned to
            // cover the right-hand (conversation) side of the screen.
            <>
              <motion.div key="pay-form-dim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.18, ease: 'easeOut' } }}
                exit={{ opacity: 0, transition: { duration: 0.12, ease: 'easeIn' } }}
                onClick={closeForm}
                style={{ position: 'fixed', inset: 0, zIndex: 140, background: 'rgba(0,0,0,0.15)' }} />
              <motion.div
                key="pay-form-drawer"
                initial={{ x: '100%' }}
                // Exit noticeably snappier than enter (higher stiffness,
                // less damping) — a dismiss should feel quicker than the
                // arrival, not mirror it 1:1.
                animate={{ x: 0, transition: { type: 'spring', stiffness: 380, damping: 34 } }}
                exit={{ x: '100%', transition: { type: 'spring', stiffness: 520, damping: 40 } }}
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 141,
                  width: 400, maxWidth: '90%', overflowY: 'auto',
                  background: 'var(--surface)', borderLeft: '1px solid var(--border)',
                  boxShadow: 'var(--shadow-3)',
                }}
              >
                {formContent}
              </motion.div>
            </>
          ) : (
            <>
              <motion.div transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40"
                onClick={closeForm} />
              <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={SHEET_SPRING}
                className="absolute bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-3xl h-[70vh] overflow-y-auto">
                {formContent}
              </motion.div>
            </>
          )
        })()}
      </AnimatePresence>

      {/* In-Chat Payment Modal — STEP 2: Review + PIN confirm (separate full-height
          sheet so the PIN keypad always has room and is never pushed off-screen) */}
      <AnimatePresence>
        {(payStep === 'confirm' || payStep === 'processing' || payStep === 'success') && (
          (() => {
            const closeStep2 = () => {
              if (payStep === 'confirm') { setPayStep('closed'); setPayPassEntry('') }
              else if (payStep === 'success') { setPayStep('closed'); setMessagesReady(true); setTimeout(() => scrollToBottom(false), 50) }
            }
            const step2Content = (
              <>
              {payStep === 'confirm' && (
                <div className="px-5 pt-3 flex-1 flex flex-col" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 12px) + 20px)' }}>
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-text-primary">Review Payment</h2>
                    <button onClick={() => setPayStep('form')} className="p-2 rounded-full hover:bg-[rgb(var(--text-primary-rgb)/0.10)] text-text-secondary"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="bg-surface rounded-2xl border border-border mt-2">
                    <div className="flex items-center justify-between px-4 py-2"><span className="text-sm text-text-secondary">Recipient</span><span className="text-sm font-semibold text-link">{recipientClean}.arc</span></div>
                    {billPay && <div className="flex items-center justify-between px-4 py-2"><span className="text-sm text-text-secondary">Order</span><span className="text-sm font-semibold text-text-primary">#{billPay.number}</span></div>}
                    <div className="flex items-center justify-between px-4 py-2"><span className="text-sm text-text-secondary">Amount</span><span className="text-sm font-bold text-text-primary">{formatAmount(parseFloat(payAmount) || 0, chatPayTokenDecimals(payToken))} {payToken}</span></div>
                    <div className="flex items-center justify-between px-4 py-2"><span className="text-sm text-text-secondary">Network Fee</span><span className="text-sm font-semibold text-success">{payEstimatedFee > 0 ? `~${formatAmount(payEstimatedFee, 4)} USDC` : 'Free'}</span></div>
                    {payNote && <div className="flex items-center justify-between px-4 py-2"><span className="text-sm text-text-secondary">Note</span><span className="text-sm text-text-primary truncate max-w-[60%]">{payNote}</span></div>}
                  </div>
                  <div className="space-y-1 mt-auto pt-2">
                    <p className="text-xs font-medium text-text-secondary text-center">Enter passcode to confirm</p>
                    <PinKeypad
                      value={payPassEntry}
                      onChange={v => setPayPassEntry(v)}
                      length={6}
                      error={!!payError}
                      onComplete={(_, viaBiometric) => { setPayViaBiometric(!!viaBiometric); executeChatPayment() }}
                    />
                    {payError && <p role="alert" className="text-xs text-danger text-center">{payError}</p>}
                  </div>
                </div>
              )}

              {payStep === 'processing' && (
                <div className="px-5 pt-10 pb-12 flex-1 flex flex-col items-center justify-center gap-4">
                  <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                    <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--brand)' }} />
                  </div>
                  <p className="text-text-primary" style={{ fontSize: 14.7, fontWeight: 700 }}>Processing payment…</p>
                  <p className="text-text-secondary" style={{ fontSize: 12.6, fontWeight: 700 }}>Do not close this screen</p>
                </div>
              )}

              {/* Full-screen brand flash - instant hide (no exit fade) the
                  moment the checkmark starts traveling, same fix PaySendPage
                  needed: a fading flash panel lingers as a translucent
                  overlay on top of the content underneath for its whole
                  exit duration, which looks like two screens stacked. */}
              {payStep === 'success' && paySuccessPhase === 'flash' && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 999, background: 'var(--brand)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: 'inherit' }}>
                  <motion.div ref={payFlashCheckRef} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 220, damping: 16 }}
                    onAnimationComplete={() => setPayFlashCircleReady(true)}
                    style={{ width: 82.08, height: 82.08, borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                    {payViaBiometric ? (
                      <FlashAuthIcon viaBiometric start={payFlashCircleReady} size={37.62} color="var(--brand)" />
                    ) : (
                      <motion.svg width={37.62} height={37.62} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay: 0.25 }} />
                      </motion.svg>
                    )}
                  </motion.div>
                  <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: 0 }}>Paid Successfully</p>
                </div>
              )}

              {payTravelRect && !payTravelDone && (
                <TravelingCheckmark from={payTravelRect.from} to={payTravelRect.to} />
              )}

              {payStep === 'success' && paySuccessPhase === 'collapsed' && (() => {
                const shortHash = payTxHash ? `${payTxHash.slice(0, 6)}...${payTxHash.slice(-4)}` : '—'
                const timeLabel = new Date().toLocaleString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
                }).replace(',', ' ·')
                const closeNow = () => { setPayStep('closed'); setMessagesReady(true); setTimeout(() => scrollToBottom(false), 50) }
                const chatSparklePath = 'M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z'
                return (
                <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
                  {/* Same hero design as the Send success screen (title,
                      sparkle-ringed checkmark, "Paid $X to Y", the
                      "Completed in Ns" pill) — compressed with fixed px
                      sizing instead of Send's clamp()/vw-based full-page
                      scale. Now also matches Send's scalloped middle-bottom
                      clip-path edge instead of a plain rounded-bottom
                      block: a few extra px of bottom padding are reserved
                      purely so the notch has room to dip into, clipped
                      away everywhere except the centered tab. */}
                  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
                    <defs>
                      <clipPath id="chatHeroBottomClip" clipPathUnits="objectBoundingBox">
                        <path d="M0,0 L1,0 L1,0.955 L0.826,0.955 C0.805,0.955 0.805,0.99 0.755,0.99 L0.245,0.99 C0.195,0.99 0.195,0.955 0.174,0.955 L0,0.955 Z" />
                      </clipPath>
                    </defs>
                  </svg>
                  <div style={{ background: 'var(--brand)', padding: '18px 16px 30px', display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, clipPath: 'url(#chatHeroBottomClip)' }}>
                    <h2 style={{ fontSize: 15, fontWeight: 700, color: '#fff', margin: '0 0 10px', textAlign: 'center' }}>Payment Successful!</h2>

                    <div ref={paySuccessCheckRef} style={{
                      position: 'relative', width: 60, height: 60, borderRadius: '50%', background: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, margin: '4px 0',
                      opacity: payTravelDone ? 1 : 0,
                    }}>
                      <svg width={11} height={11} viewBox="0 0 24 24" style={{ position: 'absolute', top: '4%', left: '-40%' }}><path d={chatSparklePath} fill="rgba(255,255,255,0.55)" /></svg>
                      <svg width={7} height={7} viewBox="0 0 24 24" style={{ position: 'absolute', top: '70%', left: '-32%' }}><path d={chatSparklePath} fill="rgba(255,255,255,0.55)" /></svg>
                      <svg width={11} height={11} viewBox="0 0 24 24" style={{ position: 'absolute', top: '2%', right: '-42%' }}><path d={chatSparklePath} fill="rgba(255,255,255,0.55)" /></svg>
                      <svg width={7} height={7} viewBox="0 0 24 24" style={{ position: 'absolute', top: '68%', right: '-30%' }}><path d={chatSparklePath} fill="rgba(255,255,255,0.55)" /></svg>
                      {payViaBiometric && payTravelDone ? (
                        <FlashAuthIcon key="landing-toggle" viaBiometric loop size={28} color="var(--brand)" />
                      ) : (
                        <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>

                    <motion.div initial={false} animate={payTravelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: payTravelDone ? 0.1 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.92)' }}>
                        <User style={{ width: 14, height: 14 }} />
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Paid</span>
                      </div>
                      <p style={{ fontSize: 22, fontWeight: 800, color: '#fff', margin: '2px 0 0', lineHeight: 1 }}>
                        {formatAmount(parseFloat(payAmount) || 0, chatPayTokenDecimals(payToken))} {payToken}
                      </p>
                      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', margin: '4px 0 0' }}>
                        to {recipientClean}.arc
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(255,255,255,0.14)', padding: '4px 9px', borderRadius: 999, marginTop: 8 }}>
                        <Zap className="w-3 h-3" style={{ color: '#FFD54A' }} fill="#FFD54A" />
                        <span style={{ fontSize: 10, fontWeight: 600, color: '#fff' }}>Completed in {elapsedSeconds} Seconds</span>
                      </div>
                    </motion.div>
                  </div>

                  <motion.div initial={false} animate={payTravelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: payTravelDone ? 0.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 16px calc(env(safe-area-inset-bottom, 16px) + 16px)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)', border: '1px solid var(--border)', borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Transaction</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{shortHash}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>To</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{recipientClean}.arc</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Network</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Arc Testnet</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Time</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{timeLabel}</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'center', gap: 40, marginBottom: 20 }}>
                      {payTxHash && (
                        <a href={`https://testnet.arcscan.app/tx/${payTxHash}`} target="_blank" rel="noopener noreferrer"
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                          <span style={{ width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                            <ExternalLink className="w-4 h-4" />
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.3 }}>View on<br />Arc Explorer</span>
                        </a>
                      )}
                      <button onClick={() => navigate('/activity')}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <span style={{ width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                          <ActivityIcon className="w-4 h-4" />
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.3 }}>View<br />Activity</span>
                      </button>
                    </div>

                    {/* Single Done button - not a two-button Pay again /
                        Back to Home footer like Send's full page has,
                        since this is a compact in-chat sheet where "Done"
                        is the only action that makes sense. */}
                    <button onClick={closeNow}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '13px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', fontSize: 15, fontWeight: 700, color: '#FFFFFF', background: 'var(--brand)', cursor: 'pointer' }}>
                      Done
                    </button>
                  </motion.div>
                </div>
                )
              })()}
              </>
            )

            // Desktop's PIN moment specifically gets the premium
            // DesktopTransactionAuthDialog (its own amount+recipient
            // summary replaces the "Review Payment" card step2Content
            // shows on mobile) — processing/success keep the plain
            // DesktopDialogFrame + the exact same step2Content mobile
            // uses, unchanged, since neither of those states is a PIN
            // entry moment.
            if (isDesktop && payStep === 'confirm') {
              return (
                <DesktopTransactionAuthDialog
                  onClose={closeStep2}
                  title="Authorize Payment"
                  amountLabel={`${formatAmount(parseFloat(payAmount) || 0, chatPayTokenDecimals(payToken))} ${payToken}`}
                  subLabel={`To ${recipientClean}.arc`}
                >
                  {payError && <p role="alert" className="text-xs text-danger text-center mb-4">{payError}</p>}
                  <PinKeypad
                    value={payPassEntry}
                    onChange={v => setPayPassEntry(v)}
                    length={6}
                    error={!!payError}
                    onComplete={(_, viaBiometric) => { setPayViaBiometric(!!viaBiometric); executeChatPayment() }}
                  />
                </DesktopTransactionAuthDialog>
              )
            }
            return isDesktop ? (
              <DesktopDialogFrame onClose={closeStep2} maxWidth={440}>
                <div className="relative flex flex-col max-h-[80vh]">{step2Content}</div>
              </DesktopDialogFrame>
            ) : (
              <>
                <motion.div transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-black/70 backdrop-blur-sm z-40"
                  onClick={closeStep2} />
                <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                  transition={SHEET_SPRING}
                  className="absolute bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-3xl h-[70vh] overflow-y-auto flex flex-col">
                  {step2Content}
                </motion.div>
              </>
            )
          })()
        )}
      </AnimatePresence>

      {/* ── Send photos: preview screen · Photo viewer (swipe through the chat's photos) ── */}
      <AnimatePresence>
        {previewItems && previewItems.length > 0 && (
          <MediaPreview key="preview" items={previewItems} recipient={otherUser?.display_name || `${recipientClean}.arc`}
            onChange={setPreviewItems}
            onAddMore={() => {
              pickModeRef.current = 'image'
              if (fileInputRef.current) { fileInputRef.current.accept = 'image/*'; fileInputRef.current.value = ''; fileInputRef.current.click() }
            }}
            onClose={() => { previewItems.forEach(i => URL.revokeObjectURL(i.url)); setPreviewItems(null) }}
            onSend={(items, hd) => {
              setPreviewItems(null)
              void sendMedia(items.map(i => ({ file: i.file, caption: i.caption })), hd, false)
                .finally(() => items.forEach(i => URL.revokeObjectURL(i.url)))
            }} />
        )}
        {viewerStartId && (() => {
          const items: ViewerItem[] = messages.filter(m => m.content !== '[deleted]').flatMap(m => {
            const md = parseMedia(plainTextOf(m.content) || m.content)
            if (!md) return []
            const isImg = md.kind === 'image' || /\.(jpe?g|png|gif|webp)$/i.test(md.name)
            return isImg ? [{ id: m.id, url: md.url, iv: md.iv, sender: m.sender_id === user?.id ? 'You' : (otherUser?.display_name || recipientClean), createdAt: m.created_at, msg: m }] : []
          })
          return (
            <ChatImageViewer key="viewer" items={items} startId={viewerStartId} convKey={convKey}
              onClose={() => setViewerStartId(null)}
              onReply={m => startReply(m)}
              onForward={m => setForwardMsgs([{ ...m, isMine: m.sender_id === user?.id }])} />
          )
        })()}
      </AnimatePresence>

      {/* ── Fullscreen media viewer ── */}
      {viewerSrc && (
        <div onClick={() => setViewerSrc(null)} style={{
          position: 'absolute', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.95)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* Close button — top right */}
          <button
            onClick={() => setViewerSrc(null)}
            style={{
              position: 'absolute', top: 16, right: 16, zIndex: 101,
              width: 44, height: 44, borderRadius: '50%',
              background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.25)',
              cursor: 'pointer', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 20, height: 20 }} />
          </button>

          {/* Download button — bottom center, pill shape, clearly labelled */}
          <button
            onClick={async (e) => {
              e.stopPropagation()
              const btn = e.currentTarget
              btn.setAttribute('disabled', 'true')
              try {
                const res = await fetch(viewerSrc)
                const blob = await res.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = viewerSrc.split('/').pop()?.split('?')[0] || 'image'
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              } catch {
                window.open(viewerSrc, '_blank')
              } finally {
                btn.removeAttribute('disabled')
              }
            }}
            style={{
              position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
              zIndex: 101,
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 28px',
              borderRadius: 999,
              background: 'var(--brand)',
              border: 'none',
              color: '#fff',
              fontSize: 15, fontWeight: 600, letterSpacing: 0.2,
              cursor: 'pointer',
              boxShadow: 'var(--shadow-2)',
              WebkitTapHighlightColor: 'transparent',
              minWidth: 160,
              justifyContent: 'center',
            }}
          >
            <ArrowDownToLine style={{ width: 18, height: 18, flexShrink: 0 }} />
            Save Image
          </button>

          <img
            src={viewerSrc}
            alt="full view"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '100vw', maxHeight: '80vh', objectFit: 'contain', borderRadius: 8 }}
          />
        </div>
      )}

      {/* ── Delete message bottom sheet ── */}
      <AnimatePresence>
        {deleteTargets && (() => {
          const n = deleteTargets.length
          const allMineRecent = deleteTargets.every((m: any) => m.isMine && m.content !== '[deleted]' && Date.now() - new Date(m.created_at).getTime() < DELETE_FOR_EVERYONE_MS)
          return (
            <motion.div key="del" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={DIALOG_BACKDROP.transition}
              className="absolute inset-0 z-50 flex items-center justify-center px-6" style={{ background: 'rgba(0,0,0,0.55)' }}
              onClick={() => !deleting && setDeleteTargets(null)}>
              <motion.div initial={DIALOG_CARD.initial} animate={DIALOG_CARD.animate} exit={DIALOG_CARD.exit} transition={DIALOG_CARD.transition}
                onClick={e => e.stopPropagation()} className="w-full rounded-3xl px-6 pt-6 pb-3"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', maxWidth: 360 }}>
                <p className="text-[18px] font-bold text-text-primary">{n > 1 ? `Delete ${n} messages?` : 'Delete message?'}</p>
                {n === 1 && deleteTargets[0].content !== '[deleted]' && (
                  <p className="mt-2 text-[13.5px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>“{messagePreview(deleteTargets[0].content)}”</p>
                )}
                <p className="mt-2 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                  {allMineRecent ? `Delete for everyone removes ${n > 1 ? 'them' : 'it'} for ${otherUser?.display_name || 'them'} too.` : 'You can delete for everyone only your own messages, within 2 days of sending.'}
                </p>
                <div className="flex flex-col items-end mt-3">
                  {allMineRecent && (
                    <button disabled={deleting} onClick={() => deleteForEveryoneMany(deleteTargets)}
                      className="py-3 px-1 text-[15px] font-semibold disabled:opacity-50 text-link">
                      {deleting ? 'Deleting…' : 'Delete for everyone'}
                    </button>
                  )}
                  <button disabled={deleting} onClick={() => deleteForMeMany(deleteTargets)} className="py-3 px-1 text-[15px] font-semibold disabled:opacity-50 text-link">Delete for me</button>
                  <button disabled={deleting} onClick={() => setDeleteTargets(null)} className="py-3 px-1 text-[15px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Cancel</button>
                </div>
              </motion.div>
            </motion.div>
          )
        })()}

        {forwardMsgs && user?.id && (
          <ChatForwardSheet key="fwd" messages={forwardMsgs} sourceKey={convKey} myUserId={user.id} walletAddress={walletAddress}
            onClose={() => setForwardMsgs(null)}
            onDone={(count) => { setForwardMsgs(null); clearSelection(); showToastMessage(count > 1 ? `Forwarded to ${count} chats` : 'Forwarded', 'success') }}
            onError={(m) => showToastMessage(m, 'error')} />
        )}

        {infoMsg && (
          <motion.div key="info" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={SHEET_SPRING}
            className="absolute inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }}>
            <div className="flex items-center gap-3 px-4 pt-header pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => setInfoMsg(null)} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button>
              <p className="text-[17px] font-semibold text-text-primary">Message info</p>
            </div>
            <div className="px-4 py-5 flex flex-col" style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)' }}>
              <div className="self-end max-w-[80%] rounded-[18px] rounded-br-[4px] px-3.5 py-2 bg-brand text-white text-[15px]">
                {messagePreview(infoMsg.content)}
                <div className="flex items-center justify-end gap-1 mt-0.5 text-[11px] text-white/60">
                  {new Date(infoMsg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  <MessageTicks msg={messages.find(m => m.id === infoMsg.id) ?? infoMsg} />
                </div>
              </div>
            </div>
            {(() => {
              const live: any = messages.find(m => m.id === infoMsg.id) ?? infoMsg
              const fmt = (t?: string | null) => t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'
              const rows: Array<[string, string, string]> = [
                ['Read', live.read_at || (live.is_read ? live.created_at : null) ? fmt(live.read_at) : 'Not yet', '#53bdeb'],
                ['Delivered', live.delivered_at ? fmt(live.delivered_at) : 'Not yet', 'var(--text-secondary)'],
                ['Sent', fmt(live.created_at), 'var(--text-secondary)'],
              ]
              return (
                <div className="mx-4 mt-4 rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
                  {rows.map(([label, value, color], i) => (
                    <div key={label} className="flex items-center gap-3 px-4 py-3.5" style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <svg width="20" height="14" viewBox="0 0 18 12" fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        {label === 'Sent' ? <path d="M3 6.5L6.5 10 14 2" /> : <><path d="M1 6.5l3.5 3.5L11 2.5" /><path d="M7 9.5l.6.5L15 2.5" /></>}
                      </svg>
                      <div>
                        <p className="text-[15px] font-semibold text-text-primary">{label}</p>
                        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })()}
          </motion.div>
        )}

        {undoDeleted && (
          <motion.div key="undo" {...SNACKBAR_MOTION}
            className="absolute left-4 right-4 z-40 flex items-center gap-3 rounded-xl px-4 py-3"
            style={{ bottom: 86, background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
            <span className="flex-1 text-[13.5px] text-text-primary">{undoDeleted.msgs.length > 1 ? `${undoDeleted.msgs.length} messages deleted for you` : 'Message deleted for you'}</span>
            <button onClick={undoDelete} className="text-[13.5px] font-bold text-link">UNDO</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
