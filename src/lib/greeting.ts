// Time-of-day greeting for the lock screen ("Good morning, Sunil").
export type GreetingTime = 'morning' | 'afternoon' | 'evening' | 'night'

export function greetingTime(d: Date = new Date()): GreetingTime {
  const h = d.getHours()
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 17) return 'afternoon'
  if (h >= 17 && h < 21) return 'evening'
  return 'night'
}

export function greetingText(t: GreetingTime): string {
  return `Good ${t}`
}
