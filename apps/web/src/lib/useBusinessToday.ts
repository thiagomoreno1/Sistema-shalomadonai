import { useEffect, useState } from 'react'
import { businessToday } from './formatters'

export function useBusinessToday() {
  const [today, setToday] = useState(businessToday)

  useEffect(() => {
    const refresh = () => {
      const nextDate = businessToday()
      setToday((currentDate) => currentDate === nextDate ? currentDate : nextDate)
    }
    const interval = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  return today
}
