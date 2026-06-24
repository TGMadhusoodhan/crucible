'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

const STATUS_DOT: Record<string, string> = {
  idle:             'bg-zinc-600',
  running:          'bg-blue-400 animate-pulse',
  paused:           'bg-yellow-400',
  waiting_conflict: 'bg-orange-400 animate-pulse',
  stopped:          'bg-red-500',
}

const STATUS_LABEL: Record<string, string> = {
  idle:             'Idle',
  running:          'Running',
  paused:           'Paused',
  waiting_conflict: 'Conflict',
  stopped:          'Stopped',
}

export function AppNav() {
  const pathname                        = usePathname()
  const { project, phase, isStreaming } = usePipelineState()

  const pipelineStatus =
    isStreaming                              ? 'running'          :
    phase === 'paused'                       ? 'paused'           :
    phase === 'stopped'                      ? 'stopped'          :
    phase === 'conflict_escalated'           ? 'waiting_conflict' :
    phase !== 'idle' && phase !== 'complete' ? 'running'          : 'idle'

  const dotCls    = STATUS_DOT[pipelineStatus]   ?? STATUS_DOT.idle!
  const statusLbl = STATUS_LABEL[pipelineStatus] ?? 'Idle'
  const projectName = project?.name

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4">
      {/* Brand */}
      <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
        <span className="text-sm font-bold tracking-tight text-zinc-100">Crucible</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 font-mono">beta</span>
      </Link>

      {/* Active project indicator */}
      <div className="flex flex-1 items-center justify-center">
        {projectName ? (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1">
            <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotCls)} />
            <span className="max-w-[220px] truncate text-xs font-semibold text-zinc-100">
              {projectName}
            </span>
            <span className="text-[10px] text-zinc-500">{statusLbl}</span>
          </div>
        ) : (
          <span className="text-[11px] text-zinc-700">No project open — select one from the left panel</span>
        )}
      </div>

      {/* Nav links */}
      <nav className="flex shrink-0 items-center gap-1">
        <NavLink href="/dashboard" active={pathname === '/dashboard'}>Pipeline</NavLink>
        <NavLink href="/settings"  active={pathname === '/settings'}>
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>
              <path d="M9.5 1h-3l-.5 2a6 6 0 0 0-1.5.87L2.4 3.2.9 5.8l1.6 1.3a5.8 5.8 0 0 0 0 1.8L.9 10.2l1.5 2.6 2.1-.67A6 6 0 0 0 6 13l.5 2h3l.5-2a6 6 0 0 0 1.5-.87l2.1.67 1.5-2.6-1.6-1.3a5.8 5.8 0 0 0 0-1.8l1.6-1.3L13.1 5.8l-2.1.67A6 6 0 0 0 10 3l-.5-2Z"/>
            </svg>
            API Keys
          </span>
        </NavLink>
        <span className="text-[10px] text-zinc-600 px-2 font-mono">local</span>
      </nav>
    </header>
  )
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300',
      )}
    >
      {children}
    </Link>
  )
}
