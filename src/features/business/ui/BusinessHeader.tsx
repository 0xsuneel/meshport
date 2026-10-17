/**
 * BusinessHeader — top bar of the merchant screen.
 * Shows store name, .arc handle, verification badge, voice toggle, and menu button.
 */
import React from 'react'
import { Mic, MicOff, ShieldCheck, AlertCircle, Clock, User, ChevronDown, Menu } from 'lucide-react'

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
}

const statusConfig: Record<VerificationStatus, { label: string; Icon: React.ElementType }> = {
  verified:   { label: 'Verified',      Icon: ShieldCheck },
  review:     { label: 'Under review',  Icon: Clock },
  unverified: { label: 'Not verified',  Icon: AlertCircle },
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
}: BusinessHeaderProps) {
  const { label, Icon } = statusConfig[status]
  const menuAction = onMenu ?? onProfile
  const initials = (avatarName ?? storeName).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'B'

  return (
    <header className="flex items-center gap-3 px-5 pt-5 pb-3">
      <button
        type="button"
        onClick={onSwitchStore}
        disabled={!onSwitchStore}
        aria-label={onSwitchStore ? `Switch store, now ${storeName}` : undefined}
        className="flex-1 min-w-0 flex items-center gap-2.5 text-left disabled:cursor-default"
      >
        <span className="shrink-0 flex items-center justify-center size-10 rounded-xl bg-brand text-white text-[15px] font-bold">
          {initials}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1">
            <span className="text-base font-semibold text-text-primary leading-tight truncate">{storeName}</span>
            {status === 'verified' && <ShieldCheck className="size-4 text-brand-text shrink-0" aria-label="Verified" />}
            {onSwitchStore && <ChevronDown className="size-4 text-text-muted shrink-0" />}
          </span>
          <span className="flex items-center gap-1 text-xs text-text-muted truncate">
            {outlet ? `${outlet} · ${handle}` : storeName === handle ? 'Business account' : handle}
            {status !== 'verified' && (
              <span className="inline-flex items-center gap-0.5 text-text-secondary shrink-0"> · <Icon className="size-3" />{label}</span>
            )}
          </span>
        </span>
      </button>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          aria-label={voiceOn ? 'Voice alerts on' : 'Voice alerts off'}
          onClick={onVoice}
          className={`inline-flex items-center justify-center size-11 rounded-[14px] border transition-colors ${voiceOn ? 'border-brand/30 bg-brand/10 text-brand-text' : 'border-border bg-card text-text-secondary'}`}
        >
          {voiceOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </button>
        {menuAction && (
          <button
            type="button"
            aria-label={onMenu ? 'Business menu' : 'Open profile'}
            onClick={menuAction}
            className="inline-flex items-center justify-center size-11 rounded-[14px] border border-border bg-card text-text-primary active:scale-95 transition-all"
          >
            {onMenu ? <Menu className="size-5" /> : <User className="size-5" />}
          </button>
        )}
      </div>
    </header>
  )
}
