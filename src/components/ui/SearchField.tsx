import { useState, type ReactNode } from 'react'

// The one search box style used across the app (Home, Chats, in-conversation
// search, Activity): a 44px pill in the card colour with a thin border, a
// search icon, a round clear (✕) button once there's text, and a green focus
// ring while typing. 16px text so iOS doesn't zoom the page on focus.
// `trailing` holds a screen's own extra control (e.g. Activity's filter).
export function SearchField({ value, onChange, placeholder, autoFocus, onFocus, onBlur, trailing, ariaLabel }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  trailing?: ReactNode
  ariaLabel?: string
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
      height: 44, padding: `0 ${trailing ? 6 : 8}px 0 14px`, borderRadius: 999, boxSizing: 'border-box',
      background: 'var(--surface)',
      border: `1px solid ${focused ? 'color-mix(in srgb, var(--success) 55%, transparent)' : 'var(--border)'}`,
      boxShadow: focused ? '0 0 0 3px color-mix(in srgb, var(--success) 14%, transparent)' : 'none',
      transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
    }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ flexShrink: 0 }}>
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        enterKeyHint="search"
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => { setFocused(true); onFocus?.() }}
        onBlur={() => { setFocused(false); onBlur?.() }}
        placeholder={placeholder}
        className="mp-search-input"
        style={{
          flex: 1, minWidth: 0, height: '100%', background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--text-primary)', fontSize: 16, padding: 0, fontFamily: 'inherit',
        }}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search"
          style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="3" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
      {trailing}
    </div>
  )
}
