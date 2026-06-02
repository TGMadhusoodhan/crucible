import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Tracing: capture 10% of transactions in prod, 100% in dev
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Session replay: 10% of sessions, 100% on error
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  integrations: [
    Sentry.replayIntegration({
      maskAllText:   true,   // mask user-typed text (task descriptions, API keys UI)
      blockAllMedia: false,
    }),
  ],

  // Reduce noise in development
  debug: false,

  // Never log API keys from error messages — belt-and-suspenders
  beforeSend(event) {
    try {
      if (event.message?.toLowerCase().includes('api key')) return null
      const rawValues = event.breadcrumbs?.values
      const crumbs = Array.isArray(rawValues) ? rawValues : []
      if (crumbs.some(b => JSON.stringify(b ?? '').toLowerCase().includes('api key'))) return null
    } catch {
      // Defensive — never let beforeSend crash
    }
    return event
  },
})
