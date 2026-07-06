'use client'

import { useEffect, useRef, useState } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { usePipelineDispatch, usePipelineState } from '@/store'
import { applyCapToBudget, cn } from '@/lib/utils'
import type { Provider, ProviderBudget } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic:  'Anthropic',
  openai:     'OpenAI',
  deepseek:   'DeepSeek',
  google:     'Google',
  mistral:    'Mistral',
  openrouter: 'OpenRouter',
  groq:       'Groq',
  together:   'Together',
  zai:        'Z.ai',
}

const ALL_PROVIDERS: Provider[] = [
  'anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together',
]

const MODE_COLORS = {
  FULL:         'bg-emerald-500',
  EFFICIENT:    'bg-yellow-500',
  CONSERVATION: 'bg-orange-500',
  CRITICAL:     'bg-red-500',
} as const

const MODE_LABELS = {
  FULL:         'Full',
  EFFICIENT:    'Efficient',
  CONSERVATION: 'Conservation',
  CRITICAL:     'Critical',
} as const

const BAR_COLORS = {
  FULL:         'bg-emerald-500',
  EFFICIENT:    'bg-yellow-500',
  CONSERVATION: 'bg-orange-500',
  CRITICAL:     'bg-red-500',
} as const

function usageColor(percentUsed: number): string {
  if (percentUsed < 50) return 'bg-emerald-500'
  if (percentUsed < 75) return 'bg-yellow-500'
  if (percentUsed < 90) return 'bg-orange-500'
  return 'bg-red-500'
}

// ─── BudgetBar ────────────────────────────────────────────────────────────────

export function BudgetBar() {
  const { budget }        = usePipelineState()
  const dispatch          = usePipelineDispatch()
  const { refreshBudget } = usePipeline()
  const [expanded, setExpanded] = useState(false)
  const [saving,   setSaving]   = useState(false)

  useEffect(() => {
    void refreshBudget()
    const id = setInterval(() => void refreshBudget(), 60_000)
    return () => clearInterval(id)
  }, [refreshBudget])

  const totalCap    = Number(budget?.totalCapUsd   ?? 0)
  const totalSpent  = Number(budget?.totalSpentUsd ?? 0)
  const pctRem      = Number(budget?.percentRemaining ?? 100)
  const pctFill     = Math.max(0, Math.min(100, 100 - pctRem))
  const mode        = budget?.mode ?? null
  const breakdown   = budget?.providerBreakdown ?? []
  const hasCaps     = totalCap > 0
  const daily       = Number(budget?.dailyAverageUsd ?? 0)

  async function saveProviderCap(provider: Provider, capUsd: number) {
    // Optimistic: update the store immediately so the UI reflects the change at once
    if (budget) dispatch({ type: 'BUDGET_UPDATE', budget: applyCapToBudget(budget, provider, capUsd) })

    setSaving(true)
    try {
      await fetch('/api/budget', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider, capUsd }),
      })
      // Sync with server truth after the write lands
      await refreshBudget()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-950 text-xs text-zinc-400">
      {/* ── Top row (always visible) ─────────────────────────────────────── */}
      <div className="flex h-8 items-center gap-3 px-4">
        {/* Mode badge */}
        <span className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-semibold text-zinc-950',
          mode ? MODE_COLORS[mode] : 'bg-zinc-700 text-zinc-400',
        )}>
          {mode ? MODE_LABELS[mode] : '—'}
        </span>

        {/* Overall progress bar */}
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              mode ? BAR_COLORS[mode] : 'bg-zinc-700',
            )}
            style={{ width: `${hasCaps ? pctFill : 0}%` }}
          />
        </div>

        {/* Spend / cap summary */}
        {hasCaps ? (
          <span className="tabular-nums text-zinc-300">
            ${totalSpent.toFixed(2)}
            <span className="text-zinc-500"> / </span>
            ${totalCap.toFixed(2)} cap
          </span>
        ) : (
          <span className="text-zinc-600">${totalSpent.toFixed(2)} spent · no limits set</span>
        )}

        {daily > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="tabular-nums text-zinc-600">${daily.toFixed(2)}/day avg</span>
          </>
        )}

        {/* Spacer + expand toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
        >
          {breakdown.length > 0
            ? `${breakdown.length} provider${breakdown.length !== 1 ? 's' : ''}`
            : 'Set limits'}
          <span className="transition-transform duration-200" style={{ display: 'inline-block', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
            ▾
          </span>
        </button>
      </div>

      {/* ── Expanded per-provider section ────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-zinc-800/60 px-4 pb-3 pt-2 space-y-2">
          {breakdown.length === 0 && (
            <p className="py-1 text-[11px] text-zinc-600">
              No limits configured. Add a provider limit below to track spending.
            </p>
          )}

          {breakdown.map((pb) => (
            <ProviderRow
              key={pb.provider}
              pb={pb}
              saving={saving}
              onSave={saveProviderCap}
            />
          ))}

          {/* Add a limit for a provider not yet tracked */}
          <AddProviderRow
            existing={breakdown.map((b) => b.provider)}
            saving={saving}
            onSave={saveProviderCap}
          />
        </div>
      )}
    </div>
  )
}

// ─── ProviderRow ──────────────────────────────────────────────────────────────

function ProviderRow({
  pb, saving, onSave,
}: {
  pb: ProviderBudget
  saving: boolean
  onSave: (provider: Provider, capUsd: number) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value,   setValue]   = useState(pb.capUsd > 0 ? String(pb.capUsd) : '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  // Keep value in sync when budget refreshes (unless actively editing)
  useEffect(() => {
    if (!editing) setValue(pb.capUsd > 0 ? String(pb.capUsd) : '')
  }, [pb.capUsd, editing])

  async function commit() {
    const num = parseFloat(value)
    if (!isNaN(num) && num >= 0 && num !== pb.capUsd) {
      await onSave(pb.provider, num)
    }
    setEditing(false)
  }

  const pct     = pb.capUsd > 0 ? Math.min(100, pb.percentUsed) : 0
  const barCls  = pb.capUsd > 0 ? usageColor(pb.percentUsed) : 'bg-zinc-600'
  const hasCap  = pb.capUsd > 0
  const left    = hasCap ? Math.max(0, pb.capUsd - pb.spentUsd) : null

  return (
    <div className="flex items-center gap-3">
      {/* Provider name */}
      <span className="w-20 shrink-0 text-[11px] font-medium text-zinc-300">
        {PROVIDER_LABELS[pb.provider]}
      </span>

      {/* Progress bar */}
      <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barCls)}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Spend numbers */}
      <span className="w-28 tabular-nums text-zinc-400 text-[11px]">
        ${pb.spentUsd.toFixed(2)}
        {hasCap && <span className="text-zinc-600"> / ${pb.capUsd.toFixed(2)}</span>}
      </span>

      {/* Remaining */}
      {hasCap && left !== null && (
        <span className={cn(
          'w-20 tabular-nums text-[11px]',
          left <= 0 ? 'text-red-400' : left < pb.capUsd * 0.1 ? 'text-orange-400' : 'text-emerald-400',
        )}>
          ${left.toFixed(2)} left
        </span>
      )}

      {/* Cap editor */}
      <div className="ml-auto flex items-center gap-1">
        {editing ? (
          <>
            <span className="text-zinc-600 text-[10px]">$</span>
            <input
              ref={inputRef}
              type="number"
              min="0"
              step="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => void commit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit()
                if (e.key === 'Escape') { setValue(pb.capUsd > 0 ? String(pb.capUsd) : ''); setEditing(false) }
              }}
              disabled={saving}
              className="w-16 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-100 outline-none focus:border-zinc-400 disabled:opacity-40"
            />
            <span className="text-[10px] text-zinc-600">/mo</span>
          </>
        ) : (
          <button
            onClick={() => { setValue(pb.capUsd > 0 ? String(pb.capUsd) : ''); setEditing(true) }}
            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
            title="Edit cap"
          >
            {hasCap ? `$${pb.capUsd}/mo ✎` : 'Set cap ✎'}
          </button>
        )}

        {/* Remove cap */}
        {hasCap && !editing && (
          <button
            onClick={() => void onSave(pb.provider, 0)}
            disabled={saving}
            className="rounded px-1 py-0.5 text-[10px] text-zinc-700 hover:text-red-500 transition-colors disabled:opacity-40"
            title="Remove cap"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

// ─── AddProviderRow ───────────────────────────────────────────────────────────

function AddProviderRow({
  existing, saving, onSave,
}: {
  existing: Provider[]
  saving: boolean
  onSave: (provider: Provider, capUsd: number) => Promise<void>
}) {
  const [open,     setOpen]     = useState(false)
  const [provider, setProvider] = useState<Provider>('deepseek')
  const [capValue, setCapValue] = useState('')

  const available = ALL_PROVIDERS.filter((p) => !existing.includes(p))
  if (available.length === 0) return null

  // Reset provider picker to first available when list changes
  if (!available.includes(provider) && available[0]) {
    setProvider(available[0])
  }

  async function handleAdd() {
    const num = parseFloat(capValue)
    if (isNaN(num) || num <= 0) return
    await onSave(provider, num)
    setCapValue('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-1 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        + Add provider limit
      </button>
    )
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as Provider)}
        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 outline-none focus:border-zinc-500"
      >
        {available.map((p) => (
          <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
        ))}
      </select>

      <span className="text-zinc-600 text-[10px]">$</span>
      <input
        type="number"
        min="1"
        step="1"
        placeholder="20"
        value={capValue}
        onChange={(e) => setCapValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleAdd()
          if (e.key === 'Escape') setOpen(false)
        }}
        autoFocus
        disabled={saving}
        className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-100 outline-none focus:border-zinc-400 disabled:opacity-40"
      />
      <span className="text-[10px] text-zinc-600">/mo</span>

      <button
        onClick={() => void handleAdd()}
        disabled={saving || !capValue}
        className="rounded bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 transition-colors"
      >
        {saving ? '…' : 'Add'}
      </button>
      <button
        onClick={() => setOpen(false)}
        className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
