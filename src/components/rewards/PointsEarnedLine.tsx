// "+20 points · Send a payment ✓" on an action's success screen, once its
// daily reward task paid out (lib/pointsEarned.ts). Nothing when it didn't
// (already earned today, a business account, the daily cap).
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { POINTS_EARNED_EVENT, recentPointsEarned } from '@/lib/pointsEarned'
import { REWARD_TASKS, type RewardActionType } from '@/lib/rewards'

export function PointsEarnedLine({ type, className }: { type: RewardActionType; className?: string }) {
  const navigate = useNavigate()
  const [points, setPoints] = useState(() => recentPointsEarned(type))
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: RewardActionType; points: number }>).detail
      if (d?.type === type) setPoints(d.points)
    }
    window.addEventListener(POINTS_EARNED_EVENT, on)
    return () => window.removeEventListener(POINTS_EARNED_EVENT, on)
  }, [type])
  if (!points) return null
  const task = REWARD_TASKS.find(t => t.type === type)
  return (
    <motion.button type="button" onClick={() => navigate('/rewards')}
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${className ?? ''}`}
      style={{ background: 'color-mix(in srgb, var(--success) 14%, transparent)', color: 'var(--success-text)' }}>
      <Sparkles className="w-3.5 h-3.5" />
      +{points} points{task ? ` · ${task.label} done` : ''}
    </motion.button>
  )
}
