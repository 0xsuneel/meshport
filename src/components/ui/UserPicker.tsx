// A "who" field that finds MeshPort people like Pay's recipient search
// (hooks/useUserSearch + useKnownPeople): recent people and contacts when
// empty; a person shows only for their full username ("sunil.arc") - never
// for part of one.
// Tapping a person fills the field as a chip (avatar, name, ×). Built for
// bottom sheets: the list scrolls on its own and taps don't drop the keyboard
// before they land.
import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { SheetLabel, sheetInputClass, sheetInputStyle } from '@/components/ui/ActionSheet'
import { useAuthStore } from '@/store'
import { useUserSearch } from '@/hooks/useUserSearch'
import { useKnownPeople } from '@/hooks/useKnownPeople'
import { arcHandle, exactPick, pickerProblem, type PersonLite } from '@/lib/userSearch'
export { exactPick, pickerProblem }
import type { DbUser } from '@/lib/supabase'

export type PickedUser = Pick<PersonLite, 'id' | 'username' | 'display_name' | 'avatar_url'>

const rowBorder = (i: number) => (i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined)

export function UserPicker({ label, hint, query, onQuery, picked, onPick, active = true, placeholder = 'Search name or username.arc', onResults }: {
  label: string
  hint?: string
  query: string
  onQuery: (q: string) => void
  picked: PickedUser | null
  /** A person tapped (null: the chip's ×). */
  onPick: (u: PickedUser | null) => void
  /** Load recent people / contacts (the sheet is open). */
  active?: boolean
  placeholder?: string
  /** What the search shows now - lets the form pick an exact match on submit. */
  onResults?: (results: DbUser[], searching: boolean) => void
}) {
  const me = useAuthStore(s => s.user?.id ?? null)
  const people = useKnownPeople(active)
  const { results, searching } = useUserSearch(picked ? '' : query, people, true)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const self = results.some(u => u.id === me)
  const shown = (query.trim() ? results : people).filter(u => u.id !== me).slice(0, query.trim() ? 20 : 6)
  const reportRef = useRef(onResults)
  reportRef.current = onResults
  useEffect(() => { reportRef.current?.(results.filter(u => u.id !== me), searching) }, [results, searching, me])

  const pick = (u: DbUser) => {
    inputRef.current?.blur()
    onPick({ id: u.id, username: u.username.replace(/\.arc$/i, ''), display_name: u.display_name, avatar_url: u.avatar_url })
    onQuery('')
  }

  if (picked) {
    const name = picked.display_name || picked.username
    return (
      <div>
        <SheetLabel>{label}</SheetLabel>
        <div className="flex items-center gap-2.5 rounded-[14px] pl-2.5 pr-1.5 border border-border" style={{ ...sheetInputStyle, minHeight: 48 }}>
          <Avatar name={name} src={picked.avatar_url ?? undefined} size="xs" />
          <div className="flex-1 min-w-0 py-1.5">
            <p className="text-[14.5px] font-semibold text-text-primary truncate leading-tight">{name}</p>
            <p className="text-[12px] text-link truncate">{arcHandle(picked.username)}</p>
          </div>
          <button type="button" onClick={() => onPick(null)} aria-label={`Remove ${name}`}
            className="flex-shrink-0 flex items-center justify-center rounded-full text-text-secondary active:scale-95 transition-transform"
            style={{ width: 36, height: 36 }}>
            <X className="size-4" strokeWidth={2.4} />
          </button>
        </div>
        {hint && <p className="text-[12px] text-text-muted mt-1.5 px-0.5">{hint}</p>}
      </div>
    )
  }

  const typed = query.trim() !== ''
  const problem = pickerProblem(query, { searching, found: shown.length, self })
  const open = (focused || typed) && (searching || shown.length > 0)
  return (
    <div>
      <SheetLabel>{label}</SheetLabel>
      <input ref={inputRef} value={query} onChange={e => onQuery(e.target.value)} maxLength={40} placeholder={placeholder} aria-label={label}
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="done"
        onFocus={() => { setFocused(true); requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: 'nearest' })) }}
        onBlur={() => setFocused(false)}
        onKeyDown={e => {
          if (e.key !== 'Enter') return
          const exact = exactPick(query, shown) as DbUser | null
          if (exact) pick(exact); else (e.target as HTMLInputElement).blur()
        }}
        className={sheetInputClass} style={sheetInputStyle} />
      <div ref={listRef}>
        {open && (
          <div role="listbox" aria-label={`${label} results`} data-no-drag
            className="mt-2 rounded-2xl overflow-y-auto overscroll-contain" style={{ maxHeight: 232, background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {!typed && <p className="px-3.5 pt-2.5 pb-1 text-[11.5px] font-bold uppercase tracking-[0.06em] text-text-secondary">Recent & contacts</p>}
            {searching && shown.length === 0 ? (
              <div className="py-5 flex items-center justify-center"><Loader2 className="size-5 animate-spin" style={{ color: 'var(--brand-text)' }} /></div>
            ) : shown.map((u, i) => {
              const name = u.display_name || u.username
              return (
                <button key={u.id} type="button" role="option" aria-selected={false}
                  // Keep focus (and the keyboard) until the tap lands.
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pick(u)}
                  className="w-full flex items-center gap-3 px-3.5 py-2.5 active:bg-text-primary/5 transition-colors text-left"
                  style={{ borderTop: !typed && i === 0 ? undefined : rowBorder(i) }}>
                  <Avatar name={name} src={u.avatar_url ?? undefined} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[14.5px] font-semibold text-text-primary truncate">{name}</p>
                    <p className="text-[12.5px] mt-0.5 truncate text-link">{arcHandle(u.username)}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {problem
        ? <p className={`text-[12px] mt-1.5 px-0.5 ${problem.tone === 'danger' ? 'text-danger font-semibold' : 'text-text-muted'}`} role={problem.tone === 'danger' ? 'alert' : undefined}>{problem.text}</p>
        : hint && <p className="text-[12px] text-text-muted mt-1.5 px-0.5">{hint}</p>}
    </div>
  )
}
