'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

// Root-level error boundary — catches errors in the root layout.
// For errors inside (dashboard), see (dashboard)/error.tsx.
export default function GlobalError({
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
    <html>
      <body className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-100 p-8">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-zinc-500">
            {error.message || 'An unexpected error occurred.'}
          </p>
          {error.digest && (
            <p className="text-xs text-zinc-700 font-mono">Error ID: {error.digest}</p>
          )}
          <button
            onClick={reset}
            className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
