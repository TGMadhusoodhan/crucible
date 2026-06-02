import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

export default async function HomePage() {
  const { userId } = await auth()
  if (userId) redirect('/dashboard')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="max-w-2xl text-center">
        <h1 className="text-5xl font-bold tracking-tight text-zinc-50">Crucible</h1>
        <p className="mt-4 text-xl text-zinc-400">Bring any AI. Build better code.</p>
        <p className="mt-2 font-mono text-sm text-zinc-500">Your models. Your code. Cross-examined.</p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            href="/sign-up"
            className="rounded-lg bg-zinc-100 px-6 py-3 text-sm font-semibold text-zinc-900 hover:bg-white transition-colors"
          >
            Get started
          </Link>
          <Link
            href="/sign-in"
            className="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-300 hover:border-zinc-500 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  )
}
