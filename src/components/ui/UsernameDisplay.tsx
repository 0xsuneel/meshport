import { cn } from '@/lib/utils'

interface UsernameDisplayProps {
  username: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  textClassName?: string
  badgeClassName?: string
}

const sizeMap = {
  xs:  { text: 'text-[11px]', badge: 'w-3.5 h-3.5', check: 'w-2 h-2',     gap: 'gap-1'   },
  sm:  { text: 'text-xs',     badge: 'w-4 h-4',     check: 'w-2.5 h-2.5', gap: 'gap-1'   },
  md:  { text: 'text-sm',     badge: 'w-4 h-4',     check: 'w-2.5 h-2.5', gap: 'gap-1.5' },
  lg:  { text: 'text-base',   badge: 'w-5 h-5',     check: 'w-3 h-3',     gap: 'gap-1.5' },
  xl:  { text: 'text-lg',     badge: 'w-5 h-5',     check: 'w-3 h-3',     gap: 'gap-2'   },
}

/**
 * Renders   sunil.arc ✅   everywhere in MeshPort.
 * Accepts: "sunil", "sunil.arc", "@sunil", "rahul.arc" — normalises all.
 * For non-MeshPort names (e.g. "Merchant Store"), shows as-is with badge.
 */
export function UsernameDisplay({
  username,
  size = 'md',
  className,
  textClassName,
  badgeClassName,
}: UsernameDisplayProps) {
  if (!username || username === 'Unknown' || username === 'unknown') return null

  // Normalise
  const raw = username.startsWith('@') ? username.slice(1) : username
  // Only append .arc for short alphanumeric+underscore usernames (MeshPort usernames)
  const isArcUsername = /^[a-z0-9_]{2,30}$/i.test(raw) || raw.endsWith('.arc')
  const display = raw.endsWith('.arc') ? raw : isArcUsername ? raw + '.arc' : raw

  const s = sizeMap[size]

  return (
    <span className={cn('inline-flex items-center flex-shrink-0 flex-wrap', s.gap, className)}>
      <span className={cn('font-semibold text-link leading-tight', s.text, textClassName)}>
        {display}
      </span>
    </span>
  )
}

/** Standalone green verified checkmark badge */
export function VerifiedBadge({
  size = 'md',
  className,
}: {
  size?: keyof typeof sizeMap
  className?: string
}) {
  return <BadgeIcon size={size} className={className} />
}

function BadgeIcon({ size, className }: { size: keyof typeof sizeMap; className?: string }) {
  const s = sizeMap[size]
  return (
    <span
      aria-label="Verified"
      className={cn(
        'rounded-full bg-success inline-flex items-center justify-center flex-shrink-0',
        s.badge,
        className
      )}
    >
      <svg
        className={s.check}
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 13l4 4L19 7" />
      </svg>
    </span>
  )
}
