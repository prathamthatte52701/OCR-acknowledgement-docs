import { useEffect, useState } from 'react'
import api, { onServerDownChange } from '../utils/api'

// Full-page overlay shown whenever the backend is unreachable (network error,
// connection refused, timeout) - as opposed to a normal 4xx/5xx from a server
// that IS up, which each page's own ErrorMessage already handles. Pings
// /health on mount to catch a down backend even on pages that make no API
// call themselves (e.g. sitting on the login page), then retries every 5s
// while down so it clears itself once the backend comes back.
export default function ServerDownBanner() {
  const [down, setDown] = useState(false)

  useEffect(() => {
    const unsubscribe = onServerDownChange(setDown)
    api.get('/health').catch(() => {})
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!down) return
    const interval = setInterval(() => { api.get('/health').catch(() => {}) }, 5000)
    return () => clearInterval(interval)
  }, [down])

  if (!down) return null

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-gray-950/95 px-4 text-center backdrop-blur-sm">
      <div className="w-14 h-14 rounded-full bg-red-900/30 flex items-center justify-center">
        <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <div>
        <p className="text-xl font-semibold text-red-400">Server is currently unreachable</p>
        <p className="mt-1 text-gray-400 text-sm">Please try again shortly.</p>
      </div>
    </div>
  )
}
