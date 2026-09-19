import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Bell } from 'lucide-react'
import { motion } from 'framer-motion'
import { useNotificationStore } from '@/store'
import { type ReactNode } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

interface PageHeaderProps {
  title: string
  showBack?: boolean
  showNotifications?: boolean
  right?: ReactNode
}

export function PageHeader({ title, showBack = true, showNotifications = false, right }: PageHeaderProps) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const { unreadCount, badgeLabel } = useNotificationStore()

  return (
    <div className="header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header">
      <div className="flex items-center gap-2">
        {showBack && !isDesktop && (
          <button
            onClick={() => navigate(-1)}
            className="back-btn"
          >
            <ChevronLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        {right}
        {showNotifications && (
          <motion.button
            onClick={() => navigate('/notifications')}
            whileTap={{ scale: 0.9 }}
            className="relative p-2 rounded-full hover:bg-text-primary/10 text-text-primary transition-colors"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <motion.span
                key={badgeLabel}
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                className="absolute top-1 right-1 w-4 h-4 bg-danger rounded-full text-[10px] font-bold flex items-center justify-center text-white"
              >
                {badgeLabel}
              </motion.span>
            )}
          </motion.button>
        )}
      </div>
    </div>
  )
}
