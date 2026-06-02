// Next.js instrumentation hook — loads Sentry on the correct runtime.
// Automatically picked up by Next.js 15+ without any config flag needed.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config')
  }
}
