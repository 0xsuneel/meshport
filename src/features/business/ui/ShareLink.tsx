/**
 * ShareLink — copyable link pill + full-width Share button.
 */
import React from 'react'
import { Copy, Check, Share2 } from 'lucide-react'
import { ShareChannels } from './ShareChannels'

export interface ShareLinkProps {
  url: string
  copied: boolean
  onCopy: () => void
  onShare: () => void
  /** WhatsApp / SMS / Email under the Share button (subject + message) */
  channels?: { subject: string; text: string }
}

export function ShareLink({ url, copied, onCopy, onShare, channels }: ShareLinkProps) {
  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Link pill */}
      <div className="flex items-center gap-2 bg-surface border border-border rounded-2xl pl-4 pr-2 py-2 min-h-[52px]">
        <span className="flex-1 text-xs text-text-muted font-mono truncate select-all">{url}</span>
        <button
          type="button"
          aria-label={copied ? 'Link copied' : 'Copy link'}
          onClick={onCopy}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors min-h-[36px] ${
            copied
              ? 'bg-success/10 text-success'
              : 'bg-border/40 text-text-secondary hover:bg-border/60'
          }`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Share CTA */}
      <button
        type="button"
        onClick={onShare}
        className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 bg-brand text-white text-sm font-semibold hover:bg-brand/90 active:scale-[0.98] transition-all"
      >
        <Share2 className="size-4" />
        Share link
      </button>
      {channels && <ShareChannels subject={channels.subject} text={channels.text} />}
    </div>
  )
}
