import { useEffect, useRef } from 'react'

export function useVisibleAutoRefresh(refresh: () => Promise<unknown>, intervalMs = 60_000) {
  const refreshRef = useRef(refresh)
  const lastRefreshAt = useRef(0)
  const refreshing = useRef(false)

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    lastRefreshAt.current = Date.now()
    const runRefresh = () => {
      const now = Date.now()
      if (document.visibilityState !== 'visible' || refreshing.current || now - lastRefreshAt.current < 5_000) return

      lastRefreshAt.current = now
      refreshing.current = true
      void Promise.resolve()
        .then(() => refreshRef.current())
        .catch(() => undefined)
        .finally(() => { refreshing.current = false })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runRefresh()
    }
    const intervalId = window.setInterval(runRefresh, intervalMs)
    window.addEventListener('focus', runRefresh)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', runRefresh)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs])
}
