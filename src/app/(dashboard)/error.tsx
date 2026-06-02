'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

// Dashboard-level error boundary — catches errors inside the dashboard layout.
// Shows a recovery UI without destroying the nav/budget bar.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="max-w-md text-center space-y-3">
        <h2 className="text-base font-semibold text-zinc-200">Something went wrong</h2>
        <p className="text-sm text-zinc-500">
          {error.message || 'An unexpected error occurred in the dashboard.'}
        </p>
        {error.digest && (
          <p className="text-xs text-zinc-700 font-mono">ID: {error.digest}</p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="rounded border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="rounded border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Reload dashboard
          </a>
        </div>
      </div>
    </div>
  )
}
