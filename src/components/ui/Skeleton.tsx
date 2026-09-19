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
export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-2">
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
