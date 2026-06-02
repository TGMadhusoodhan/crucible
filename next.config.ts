import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  // instrumentation.ts is automatically picked up in Next.js 15+
}

export default withSentryConfig(nextConfig, {
  // Sentry organisation / project (from SENTRY_ORG / SENTRY_PROJECT env, or inferred from auth token)
  org:     process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Auth token for source map uploads — set in CI/CD, not required locally
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress the Sentry CLI output during builds
  silent: true,

  // Upload source maps in production only
  sourcemaps: {
    disable: process.env.NODE_ENV !== 'production',
  },

  // Disable the Sentry telemetry about the build plugin itself
  telemetry: false,

  // Don't add automatic performance instrumentation to every route —
  // we instrument the pipeline phases explicitly via captureException.
  autoInstrumentServerFunctions: false,
  autoInstrumentMiddleware: false,
})
