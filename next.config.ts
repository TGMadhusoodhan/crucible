import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  // Required for Docker: produces .next/standalone with self-contained server
  output: 'standalone',

  // Tell Next.js not to bundle better-sqlite3 (native module — cannot be bundled)
  serverExternalPackages: ['better-sqlite3'],
}

export default withSentryConfig(nextConfig, {
  org:     process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,

  // Only upload source maps when SENTRY_AUTH_TOKEN is explicitly provided.
  // During Docker builds, no auth token = no upload (but runtime reporting still works).
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },

  telemetry: false,
  autoInstrumentServerFunctions: false,
  autoInstrumentMiddleware: false,
})
