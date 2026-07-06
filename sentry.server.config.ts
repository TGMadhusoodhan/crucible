import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  debug: false,

  initialScope: {
    tags: { distribution: process.env.CRUCIBLE_DISTRIBUTION ?? 'docker' },
  },

  // Sentry v10 bug: event.breadcrumbs.values.filter is not a function —
  // breadcrumbs.values is a scope getter in some code paths, not an array.
  // maxBreadcrumbs: 0 ensures values is always [], so .filter() never crashes.
  maxBreadcrumbs: 0,

  // Architecture rule: never send events that mention API key material.
  beforeSend(event) {
    try {
      const exMsg = event.exception?.values?.[0]?.value ?? ''
      if (exMsg.toLowerCase().includes('encrypted_key')) return null
    } catch {
      // Defensive — never let beforeSend crash
    }
    return event
  },
})
