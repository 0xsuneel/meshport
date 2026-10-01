import { cn } from '@/lib/utils'

interface SkeletonProps {
  className?: string
}

/** Single shimmer block — compose into row/card skeletons per screen. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn('rounded-xl bg-border/60 relative overflow-hidden', className)}
      aria-hidden="true"
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-text-primary/[0.06] to-transparent" />
    </div>
  )
}

/** Common "list of rows with an avatar + two lines" skeleton, e.g. contacts,
 * activity, chat list — used instead of every screen building its own. */
export function SkeletonRows({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1 px-5 py-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <Skeleton className="w-11 h-11 rounded-full flex-shrink-0" />
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Balance-card-shaped skeleton, e.g. Home while the wallet balance loads. */
export function SkeletonCard({ className }: SkeletonProps) {
  return <Skeleton className={cn('h-32 w-full rounded-3xl', className)} />
}

/** Rounded list cards (icon, two lines, amount) — Activity, P2P lists. */
export function SkeletonCards({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-3xl px-4 py-3.5 flex items-center gap-3.5"
          style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
          <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton className="h-3.5 w-1/3 rounded-full" />
            <Skeleton className="h-3 w-1/4 rounded-full" />
          </div>
          <Skeleton className="h-4 w-16 rounded-full" />
        </div>
      ))}
    </div>
  )
}

/** Chat thread placeholder — a few bubbles on alternating sides. */
export function SkeletonChat() {
  const rows: Array<[boolean, string]> = [[false, 'w-3/5'], [false, 'w-2/5'], [true, 'w-1/2'], [false, 'w-2/3'], [true, 'w-2/5'], [true, 'w-3/5']]
  return (
    <div className="flex flex-col gap-3 px-4 py-6 w-full" aria-busy="true" aria-label="Loading">
      {rows.map(([mine, w], i) => (
        <div key={i} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
          <Skeleton className={cn('h-10 rounded-2xl', w)} />
        </div>
      ))}
    </div>
  )
}
