// Business → Summaries & cash-out day (27 Nov): the daily and weekly sales
// summaries and the cash-out day reminder are sent by the server
// (business_daily_summaries, hourly), in the business's own time zone. The
// business picks them here.
import { supabase } from '@/lib/supabase'

export type BusinessAlerts = {
  daily: boolean
  /** Local hour (0-23) for the daily summary; the weekly one comes Mondays at the same hour. */
  hour: number
  weekly: boolean
  /** 0 Sunday .. 6 Saturday; null = no cash-out reminder. */
  cashoutDay: number | null
  cashoutHour: number
  timeZone: string
}

export const DEFAULT_ALERTS: BusinessAlerts = { daily: true, hour: 21, weekly: true, cashoutDay: null, cashoutHour: 10, timeZone: 'UTC' }

export async function getBusinessAlerts(): Promise<BusinessAlerts> {
  const { data, error } = await supabase.rpc('get_my_business_alerts')
  if (error) throw new Error(error.message)
  const v = (data ?? {}) as Partial<BusinessAlerts>
  return {
    daily: v.daily ?? DEFAULT_ALERTS.daily,
    hour: typeof v.hour === 'number' ? v.hour : DEFAULT_ALERTS.hour,
    weekly: v.weekly ?? DEFAULT_ALERTS.weekly,
    cashoutDay: typeof v.cashoutDay === 'number' ? v.cashoutDay : null,
    cashoutHour: typeof v.cashoutHour === 'number' ? v.cashoutHour : DEFAULT_ALERTS.cashoutHour,
    timeZone: v.timeZone || 'UTC',
  }
}

export async function saveBusinessAlerts(a: BusinessAlerts): Promise<void> {
  const { error } = await supabase.rpc('set_my_business_alerts', {
    p_daily: a.daily, p_hour: a.hour, p_weekly: a.weekly, p_cashout_day: a.cashoutDay, p_cashout_hour: a.cashoutHour,
  })
  if (error) throw new Error(error.message)
}

/** "9 pm", "12 pm", "6 am". */
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24
  return `${x % 12 === 0 ? 12 : x % 12} ${x < 12 ? 'am' : 'pm'}`
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** One line for the Account row: "Daily 9 pm · Weekly · Cash out Fridays". */
export function alertsSummary(a: BusinessAlerts): string {
  const parts = [a.daily ? `Daily ${hourLabel(a.hour)}` : null, a.weekly ? 'Weekly' : null,
    a.cashoutDay !== null ? `Cash out ${WEEKDAY_NAMES[a.cashoutDay]}s` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Off'
}
