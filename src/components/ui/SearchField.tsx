import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAutoFocus } from '@/hooks/useAutoFocus'

// The one search box style used across the app (Home, Chats, in-conversation
// search, Activity): a 44px pill in the card colour with a thin border, a
// search icon, a round clear (✕) button once there's text, and a green focus
// ring while typing. 16px text so iOS doesn't zoom the page on focus.
// `trailing` holds a screen's own extra control (e.g. Activity's filter).
// `placeholder` can be a list, longest first: the longest one that fits the
// box is shown (in a slightly smaller hint size), so a hint never runs under
// a trailing control or gets cut mid-word on a narrow phone.
// `wrap` lets long text (a pasted 0x address) wrap onto more lines instead of
// scrolling out of view; the box grows to fit.
/** Hint size when `placeholder` is a list (matches .mp-search-fit in index.css). */
const HINT_FONT_PX = 14

export function SearchField({ value, onChange, placeholder, autoFocus, onFocus, onBlur, trailing, ariaLabel, wrap }: {
  value: string
  onChange: (v: string) => void
  placeholder: string | string[]
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  trailing?: ReactNode
  ariaLabel?: string
  wrap?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const hints = Array.isArray(placeholder) ? placeholder : [placeholder]
  const [hint, setHint] = useState(hints[0])
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useAutoFocus(wrap ? areaRef : inputRef, !!autoFocus)
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
    fit()
    // Re-fit when the box's width changes (not on our own height change).
    let w = el.clientWidth
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit() } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [value, wrap])
  // Pick the longest hint that fits the input's current width.
  const hintKey = hints.join('|')
  useLayoutEffect(() => {
    const el = (wrap ? areaRef.current : inputRef.current) as HTMLElement | null
    const list = hintKey.split('|')
    if (!el || list.length < 2) { setHint(list[0]); return }
    const ctx = document.createElement('canvas').getContext('2d')
    const pick = () => {
      const cs = getComputedStyle(el)
      if (!ctx) return
      ctx.font = `${cs.fontWeight} ${HINT_FONT_PX}px ${cs.fontFamily}`
      const room = el.clientWidth - 2
      setHint(list.find(h => ctx.measureText(h).width <= room) ?? list[list.length - 1])
    }
    pick()
    const ro = new ResizeObserver(pick)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hintKey, wrap])
  const fitted = hints.length > 1
  const common = {
    'aria-label': ariaLabel ?? hints[0],
    value,
    onFocus: () => { setFocused(true); onFocus?.() },
    onBlur: () => { setFocused(false); onBlur?.() },
    placeholder: hint,
    className: fitted ? 'mp-search-input mp-search-fit' : 'mp-search-input',
  }
  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
      // minHeight too: in a column layout `flex: 1` overrides `height`, and the
      // box shrank to its text (the Guests screen's thin search box).
      ...(wrap ? { minHeight: 44, borderRadius: 22 } : { height: 44, minHeight: 44, borderRadius: 999 }),
      padding: `0 ${trailing ? 6 : 8}px 0 14px`, boxSizing: 'border-box',
      background: 'var(--surface)',
      border: `1px solid ${focused ? 'color-mix(in srgb, var(--success) 55%, transparent)' : 'var(--border)'}`,
      boxShadow: focused ? '0 0 0 3px color-mix(in srgb, var(--success) 14%, transparent)' : 'none',
      transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
    }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ flexShrink: 0 }}>
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      {wrap ? (
        <textarea
          {...common}
          ref={areaRef}
          rows={1}
          enterKeyHint="search"
          spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={e => onChange(e.target.value.replace(/[\r\n]+/g, ''))}
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
          style={{
            flex: 1, minWidth: 0, display: 'block', background: 'transparent', border: 'none', outline: 'none', resize: 'none', overflow: 'hidden',
            color: 'var(--text-primary)', fontSize: 16, lineHeight: '22px', padding: '10px 0', fontFamily: 'inherit',
            // Only typed text wraps; the hint stays on one line.
            ...(value ? { wordBreak: 'break-all' } : { whiteSpace: 'nowrap', textOverflow: 'ellipsis' }),
          }}
        />
      ) : (
        <input
          {...common}
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          onChange={e => onChange(e.target.value)}
          style={{
            flex: 1, minWidth: 0, height: '100%', background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontSize: 16, padding: 0, fontFamily: 'inherit',
          }}
        />
      )}
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
