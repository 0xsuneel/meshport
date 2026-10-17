/**
 * BusinessHeader — top bar of the merchant screen.
 * Shows store name, .arc handle, verification badge, voice toggle, and menu button.
 */
import React from 'react'
import { Mic, MicOff, ShieldCheck, AlertCircle, Clock, User, ChevronDown, LayoutGrid } from 'lucide-react'
import { IconBtn, StatusDot } from './primitives'

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
}: BusinessHeaderProps) {
  const { label, Icon } = statusConfig[status]
  // onMenu takes priority; fall back to onProfile for backwards compat
  const menuAction = onMenu ?? onProfile

  return (
    <header className="flex items-center gap-3 px-5 pt-5 pb-3">
      {/* Left: store name + handle + status */}
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onSwitchStore}
          disabled={!onSwitchStore}
          className="flex items-center gap-1 disabled:cursor-default group"
          aria-label={onSwitchStore ? 'Switch store' : undefined}
        >
          <h1 className="text-lg font-semibold text-text-primary leading-tight truncate">
            {storeName}
          </h1>
          {onSwitchStore && (
            <ChevronDown className="size-4 text-text-muted group-hover:text-text-secondary transition-colors shrink-0" />
          )}
        </button>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xs text-text-muted font-mono truncate">{handle}</span>
          <span className="text-text-muted opacity-40">·</span>
          <StatusDot status={status} />
          <span className="text-xs text-text-secondary flex items-center gap-1">
            <Icon className="size-3" />
            {label}
          </span>
        </div>
      </div>

      {/* Right: voice toggle + menu / profile */}
      <div className="flex items-center gap-1 shrink-0">
        <IconBtn
          label={voiceOn ? 'Disable voice alerts' : 'Enable voice alerts'}
          onClick={onVoice}
          className={voiceOn ? 'text-brand-text bg-brand/10' : ''}
        >
          {voiceOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </IconBtn>

        {menuAction && (
          <button
            type="button"
            aria-label={onMenu ? 'Business menu' : 'Open profile'}
            onClick={menuAction}
            className="inline-flex items-center justify-center size-11 rounded-2xl text-text-secondary hover:bg-border/30 active:scale-95 transition-all"
          >
            {onMenu ? <LayoutGrid className="size-5" /> : <User className="size-5" />}
          </button>
        )}
      </div>
    </header>
  )
}
