import type { CSSProperties } from 'react'
import { cn, getInitials, getAvatarColor } from '@/lib/utils'

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
  const gradient = getAvatarColor(name.toLowerCase())
  // A query string that changes between fetches of the same underlying
  // image (even an unintentional one — e.g. a stale cache-busting param
  // left over from an old upload flow) makes the browser treat every
  // fetch as a brand-new resource, defeating HTTP caching entirely: the
  // avatar visibly reloads/flickers every time this component remounts,
  // even though the actual picture hasn't changed. Stripping it here
  // means a stable, cacheable URL reaches the <img> tag regardless of
  // what the caller passed in.
  const stableSrc = src ? src.split('?')[0] : src

  if (stableSrc) {
    return (
      <img
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
            div.className = el.className.replace('object-cover', '') +
              ` ${gradient} flex items-center justify-center font-semibold text-white`
            div.textContent = initials
            parent.replaceChild(div, el)
          }
        }}
      />
    )
  }

  return (
    <div
      style={style}
      className={cn(
        sizeMap[size],
        gradient,
        'rounded-full flex items-center justify-center flex-shrink-0 font-semibold text-white',
        showRing && 'ring-2 ring-brand ring-offset-2 ring-offset-surface',
        className
      )}
    >
      {initials}
    </div>
  )
}
