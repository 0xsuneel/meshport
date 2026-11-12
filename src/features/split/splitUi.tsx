// Small shared pieces of the Split screens: the page header, a person's
// avatar, cards, a progress bar, status pills and the bottom action bar.
import type { CSSProperties, ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { RECENT_AVATAR_COLORS } from '@/lib/recentContacts'

export function SplitHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <div className="header-row mp-glass-header sticky top-0 z-20 gap-3 px-5 pt-header pb-header">
      {onBack && (
        <button onClick={onBack} className="back-btn" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-primary" />
        </button>
      )}
      <h1 className="header-title" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
      {right}
    </div>
  )
}

function colorFor(key: string): string {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return RECENT_AVATAR_COLORS[h % RECENT_AVATAR_COLORS.length]
}

export function SplitAvatar({ name, username, avatar, you, size = 40 }: { name?: string | null; username?: string | null; avatar?: string | null; you?: boolean; size?: number }) {
  const label = you ? 'Y' : (name || username || '?').trim().charAt(0).toUpperCase()
  const base: CSSProperties = { width: size, height: size, borderRadius: '50%', flexShrink: 0 }
  if (avatar && !you) return <img src={avatar} alt="" decoding="async" style={{ ...base, objectFit: 'cover', display: 'block' }} />
  return (
    <div aria-hidden style={{ ...base, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800,
      fontSize: Math.round(size * 0.38), background: you ? 'var(--brand)' : colorFor(username || name || '?') }}>{label}</div>
  )
}

export const card: CSSProperties = { background: 'var(--surface)', borderRadius: 18, padding: 16 }
export const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12 }
export const subStyle: CSSProperties = { fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.35 }
export const nameStyle: CSSProperties = { fontSize: 15, fontWeight: 650, color: 'var(--text-primary)', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
export const amountStyle: CSSProperties = { fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }

/** A list inside one card, rows split by a hairline. */
export function ListCard({ children }: { children: ReactNode[] | ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean)
  return (
    <div style={{ ...card, padding: '4px 16px' }}>
      {items.map((c, i) => (
        <div key={i} style={{ padding: '12px 0', borderTop: i ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none' }}>{c}</div>
      ))}
    </div>
  )
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div style={{ height: 8, borderRadius: 99, overflow: 'hidden', background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
      <div style={{ height: '100%', width: `${Math.max(0, Math.min(1, value)) * 100}%`, borderRadius: 99, background: 'var(--brand)', transition: 'width .4s ease' }} />
    </div>
  )
}

export function Pill({ tone, children }: { tone: 'paid' | 'pending' | 'muted'; children: ReactNode }) {
  const t = tone === 'paid'
    ? { bg: 'color-mix(in srgb, var(--brand) 14%, transparent)', fg: 'var(--brand-text)' }
    : tone === 'pending'
      ? { bg: 'color-mix(in srgb, var(--warning) 16%, transparent)', fg: 'var(--warning-text, var(--warning))' }
      : { bg: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', fg: 'var(--text-secondary)' }
  return <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{children}</span>
}

/** Bottom bar with the page's main action(s), above the safe area. */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: 'sticky', bottom: 0, display: 'flex', gap: 10, padding: '10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)',
      background: 'linear-gradient(to bottom, transparent, var(--bg) 24%)', marginTop: 'auto' }}>{children}</div>
  )
}

export function Btn({ children, onClick, disabled, kind = 'primary', style }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' | 'soft'; style?: CSSProperties }) {
  const look: CSSProperties = kind === 'primary'
    ? { background: 'var(--brand)', color: '#fff', border: 'none' }
    : kind === 'soft'
      ? { background: 'color-mix(in srgb, var(--brand) 13%, transparent)', color: 'var(--brand-text)', border: 'none' }
      : { background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ flex: 1, height: 54, borderRadius: 18, fontSize: 16, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, ...look, ...style }}>{children}</button>
  )
}

export function Tick({ size = 72 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
    </div>
  )
}

/** "Today, 6:08 PM" / "Yesterday, 9:15 AM" / "09 Oct, 2:10 PM". */
export function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const date = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  return `${date}, ${time}`
}

/**
 * Expense categories, each with its icon - grouped the way expense apps do
 * (Splitwise: Food & drink, Home, Transport, Entertainment, Life…). The
 * category is picked from the expense's name ("Uber to airport" → Taxi) until
 * one is chosen by hand.
 */
export interface SplitCategory { id: string; label: string; emoji: string; words: RegExp }
export const SPLIT_CATEGORIES: SplitCategory[] = [
  { id: 'dining',    label: 'Dining out',  emoji: '🍕', words: /\b(dinner|lunch|breakfast|brunch|meal|restaurant|food|pizza|biryani|burger|cafe|dine|dining|swiggy|zomato|treat)\b/i },
  { id: 'groceries', label: 'Groceries',   emoji: '🛒', words: /\b(grocer(y|ies)|supermarket|vegetables?|fruits?|milk|blinkit|zepto|bigbasket|instamart|dmart|kirana)\b/i },
  { id: 'coffee',    label: 'Coffee',      emoji: '☕', words: /\b(coffee|chai|tea|starbucks|snacks?)\b/i },
  { id: 'drinks',    label: 'Drinks',      emoji: '🍻', words: /\b(drinks?|beers?|bar|pub|party|wine|cocktails?)\b/i },
  { id: 'rent',      label: 'Rent',        emoji: '🏠', words: /\b(rent|flat|apartment|house|pg|hostel|deposit|maintenance)\b/i },
  { id: 'utilities', label: 'Utilities',   emoji: '💡', words: /\b(electricity|power|water|gas|wifi|wi-fi|internet|broadband|bill|utilities|recharge|phone)\b/i },
  { id: 'taxi',      label: 'Taxi',        emoji: '🚕', words: /\b(cab|taxi|uber|ola|rapido|auto|ride)\b/i },
  { id: 'fuel',      label: 'Fuel',        emoji: '⛽', words: /\b(fuel|petrol|diesel|gas station|toll|parking)\b/i },
  { id: 'travel',    label: 'Travel',      emoji: '✈️', words: /\b(flights?|trip|travel|train|bus|tickets?|airport|vacation|holiday|goa)\b/i },
  { id: 'hotel',     label: 'Hotel',       emoji: '🏨', words: /\b(hotel|stay|airbnb|resort|room|booking)\b/i },
  { id: 'movies',    label: 'Movies',      emoji: '🎬', words: /\b(movies?|cinema|film|netflix|show|concert|event|game|match|sports?)\b/i },
  { id: 'shopping',  label: 'Shopping',    emoji: '🛍️', words: /\b(shopping|clothes|shoes|amazon|flipkart|myntra|mall)\b/i },
  { id: 'gifts',     label: 'Gifts',       emoji: '🎁', words: /\b(gifts?|birthday|wedding|anniversary|present|farewell)\b/i },
  { id: 'health',    label: 'Health',      emoji: '💊', words: /\b(medicines?|doctor|hospital|pharmacy|clinic|gym|health)\b/i },
  { id: 'other',     label: 'Other',       emoji: '🧾', words: /$^/ },
]
export const DEFAULT_SPLIT_CATEGORY = SPLIT_CATEGORIES[SPLIT_CATEGORIES.length - 1]
/** The category an expense's name points to (Other when nothing matches). */
export function categoryForTitle(title: string): SplitCategory {
  return SPLIT_CATEGORIES.find(c => c.words.test(title)) ?? DEFAULT_SPLIT_CATEGORY
}
export function categoryForEmoji(emoji: string | null | undefined): SplitCategory {
  return SPLIT_CATEGORIES.find(c => c.emoji === emoji) ?? DEFAULT_SPLIT_CATEGORY
}
