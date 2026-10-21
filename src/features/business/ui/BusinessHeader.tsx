/**
 * BusinessHeader — top bar of the merchant screen.
 * Shows store name, .arc handle, verification badge, voice toggle, and menu button.
 */
import React from 'react'
import { Mic, MicOff, ShieldCheck, Clock, User, ChevronDown, Menu } from 'lucide-react'

export type VerificationStatus = 'verified' | 'review' | 'unverified'

export interface BusinessHeaderProps {
  storeName: string
  handle: string             // e.g. "sharma.arc"
  status: VerificationStatus
  voiceOn: boolean
  onVoice: () => void
  /** Replaces the person icon with a grid menu button. Preferred over onProfile. */
  onMenu?: () => void
  /** Backwards-compatible — ignored when onMenu is provided. */
  onProfile?: () => void
  /** Optional — shows a chevron next to the store name for multi-store switching. */
  onSwitchStore?: () => void
  /** Active outlet, shown before the handle ("MG Road · chai.arc") */
  outlet?: string | null
  /** Name the initials tile is made from (the business), when the title shows a store */
  avatarName?: string
  /** The business logo (profile photo) */
  avatarUrl?: string
  /** Desktop: a page title like the other desktop pages (the top bar already
   *  shows the account's avatar and name). */
  desktop?: boolean
}

export function BusinessHeader({
  storeName,
  handle,
  status,
  voiceOn,
  onVoice,
  onMenu,
  onProfile,
  onSwitchStore,
  outlet,
  avatarName,
  avatarUrl,
  desktop = false,
}: BusinessHeaderProps) {
  const menuAction = onMenu ?? onProfile
  const initials = (avatarName ?? storeName).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'B'

  // Same look as Home's header: round avatar with a brand ring, name + a
  // small second line, round outlined icon buttons on the right.
  const roundBtn = 'inline-flex items-center justify-center size-[38px] rounded-full shrink-0 active:scale-95 transition-transform'
  const roundStyle = { background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 15%, transparent)' }
  const buttons = (
    <div className="flex items-center gap-2 shrink-0">
      <button type="button" aria-label={voiceOn ? 'Voice alerts on' : 'Voice alerts off'} onClick={onVoice}
        className={roundBtn} style={roundStyle}>
        {voiceOn ? <Mic className="size-4 text-brand-text" /> : <MicOff className="size-4 text-text-secondary" />}
      </button>
      {menuAction && (
        <button type="button" aria-label={onMenu ? 'Business menu' : 'Open profile'} onClick={menuAction}
          className={roundBtn} style={roundStyle}>
          {onMenu ? <Menu className="size-4 text-brand-text" /> : <User className="size-4 text-brand-text" />}
        </button>
      )}
    </div>
  )
  if (desktop) return (
    <header className="flex items-center gap-3 px-5 pb-4">
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-bold text-text-primary leading-tight">Business</h1>
        <button type="button" onClick={onSwitchStore} disabled={!onSwitchStore}
          className="flex items-center gap-1 mt-1 max-w-full text-left text-[13px] text-text-secondary disabled:cursor-default">
          <span className="font-semibold truncate">{storeName}</span>
          {status === 'verified' && <ShieldCheck className="size-3.5 text-brand-text shrink-0" aria-label="Verified" />}
          {status === 'review' && <Clock className="size-3.5 text-warning shrink-0" aria-label="Under review" />}
          {onSwitchStore && <ChevronDown className="size-3.5 text-text-muted shrink-0" />}
          {storeName !== handle && <span className="text-link truncate" style={{ fontFamily: 'monospace' }}>· {outlet ? `${outlet} · ${handle}` : handle}</span>}
        </button>
      </div>
      {buttons}
    </header>
  )
  return (
    <header className="flex items-center gap-3 px-5 pb-3" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + var(--home-header-gap, 14px))' }}>
      <button
        type="button"
        onClick={onSwitchStore}
        disabled={!onSwitchStore}
        aria-label={onSwitchStore ? `Switch store, now ${storeName}` : undefined}
        className="flex-1 min-w-0 flex items-center gap-2.5 text-left disabled:cursor-default"
      >
        <span className="shrink-0 rounded-full p-[2px] bg-brand" style={{ width: 47, height: 47 }}>
          {avatarUrl
            ? <img src={avatarUrl.split('?')[0]} alt="" className="w-full h-full rounded-full object-cover" style={{ border: '2px solid var(--bg)' }} />
            : <span className="flex items-center justify-center w-full h-full rounded-full bg-brand text-white text-[17px] font-bold" style={{ border: '2px solid var(--bg)' }}>
                {initials.slice(0, 1)}
              </span>}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1">
            <span className="text-[15px] font-bold text-text-primary truncate" style={{ letterSpacing: '-0.3px' }}>{storeName}</span>
            {status === 'verified' && <ShieldCheck className="size-4 text-brand-text shrink-0" aria-label="Verified" />}
            {status === 'review' && <Clock className="size-3.5 text-warning shrink-0" aria-label="Under review" />}
            {onSwitchStore && <ChevronDown className="size-4 text-text-muted shrink-0" />}
          </span>
          <span className="flex items-center gap-1 mt-0.5 text-[11.5px] text-link truncate" style={{ fontFamily: 'monospace' }}>
            {outlet ? `${outlet} · ${handle}` : storeName === handle ? 'Business account' : handle}
          </span>
        </span>
      </button>

      {buttons}
    </header>
  )
}
