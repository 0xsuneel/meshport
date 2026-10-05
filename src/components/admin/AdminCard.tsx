import type { ReactNode, CSSProperties } from 'react'

interface AdminCardProps {
  children: ReactNode
  style?: CSSProperties
  onClick?: () => void
  padding?: number | string
}

export function AdminCard({ children, style, onClick, padding = 16 }: AdminCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        padding,
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
