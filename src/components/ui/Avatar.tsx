import type { CSSProperties } from 'react'
import { cn, getInitials } from '@/lib/utils'

// Letter avatars (no photo): the pastel tiles, picked by the name's first letter.
const TONES = ['mint', 'peach', 'butter'] as const
function toneOf(name: string) {
  const t = TONES[(name.toLowerCase().charCodeAt(0) || 0) % TONES.length]
  return { background: `var(--tile-${t})`, color: `var(--tile-${t}-ink)` }
}

interface AvatarProps {
  name: string
  src?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  showRing?: boolean
  style?: CSSProperties
}

const sizeMap = {
  xs: 'w-[29px] h-[29px] text-xs',
  sm: 'w-[38px] h-[38px] text-sm',
  md: 'w-[46px] h-[46px] text-base',
  lg: 'w-[59px] h-[59px] text-lg',
  xl: 'w-[84px] h-[84px] text-2xl',
}

export function Avatar({ name, src, size = 'md', className, showRing, style }: AvatarProps) {
  const initials = getInitials(name)
  const tone = toneOf(name)
  // A query string that changes between fetches of the same underlying
  // image (even an unintentional one - e.g. a stale cache-busting param
  // left over from an old upload flow) makes the browser treat every
  // fetch as a brand-new resource, defeating HTTP caching entirely: the
  // avatar visibly reloads/flickers every time this component remounts,
  // even though the actual picture hasn't changed. Stripping it here
  // means a stable, cacheable URL reaches the <img> tag regardless of
  // what the caller passed in.
  const stableSrc = src ? src.split('?')[0] : src

  if (stableSrc) {
    return (
      <img decoding="async"
        src={stableSrc}
        alt={name}
        style={style}
        className={cn(
          sizeMap[size],
          'rounded-full object-cover flex-shrink-0',
          showRing && 'ring-2 ring-brand ring-offset-2 ring-offset-surface',
          className
        )}
        onError={(e) => {
          // On load error, hide img and show initials fallback
          const el = e.currentTarget
          el.style.display = 'none'
          const parent = el.parentElement
          if (parent) {
            const div = document.createElement('div')
            div.className = el.className.replace('object-cover', '') + ' flex items-center justify-center font-semibold'
            div.style.background = tone.background
            div.style.color = tone.color
            div.textContent = initials
            parent.replaceChild(div, el)
          }
        }}
      />
    )
  }

  return (
    <div
      style={{ ...tone, ...style }}
      className={cn(
        sizeMap[size],
        'rounded-full flex items-center justify-center flex-shrink-0 font-semibold',
        showRing && 'ring-2 ring-brand ring-offset-2 ring-offset-surface',
        className
      )}
    >
      {initials}
    </div>
  )
}
