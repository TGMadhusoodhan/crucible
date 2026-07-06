'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { applyCapToBudget, cn } from '@/lib/utils'
import type { BudgetStatus, Provider, ProviderBudget } from '@/types'

const ALL_PROVIDERS: Provider[] = [
  'anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together', 'zai',
]

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic:  'Anthropic (Claude)',
  openai:     'OpenAI (GPT)',
  deepseek:   'DeepSeek',
  google:     'Google (Gemini)',
  mistral:    'Mistral / Codestral',
  openrouter: 'OpenRouter',
  groq:       'Groq',
  together:   'Together AI',
  zai:        'Z.ai (GLM)',
}

function usageColor(percentUsed: number) {
  if (percentUsed < 50) return 'bg-emerald-500'
  if (percentUsed < 75) return 'bg-yellow-500'
  if (percentUsed < 90) return 'bg-orange-500'
  return 'bg-red-500'
}

export function BudgetSettings() {
  const [status,  setStatus]  = useState<BudgetStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/budget')
      const data = await res.json() as { success: boolean; data?: BudgetStatus }
      if (data.success && data.data) setStatus(data.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function saveCap(provider: Provider, capUsd: number) {
    // Optimistic: update local state immediately
    if (status) setStatus(applyCapToBudget(status, provider, capUsd))

    setSaving(true)
    setError('')
    try {
      const res  = await fetch('/api/budget', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider, capUsd }),
      })
      const data = await res.json() as { success: boolean; error?: string }
      if (!data.success) { setError(data.error ?? 'Save failed'); await load(); return }
      await load()
    } catch {
      setError('Network error')
      await load()  // revert optimistic update on error
    } finally {
      setSaving(false)
    }
  }

  const breakdown   = status?.providerBreakdown ?? []
  const totalCap    = status?.totalCapUsd ?? 0
  const totalSpent  = status?.totalSpentUsd ?? 0
  const unconfigured = ALL_PROVIDERS.filter((p) => !breakdown.some((b) => b.provider === p))

  return (
    <div>
      <h2 className="mb-1 text-sm font-semibold text-zinc-100">Spending limits</h2>
      <p className="mb-5 text-xs text-zinc-500">
        Set a monthly USD cap per provider. Crucible tracks what it spends through your API keys
        and warns when you approach the limit. Does not affect your actual provider balance.
      </p>

      {error && (
        <div className="mb-4 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Total cap summary */}
      {totalCap > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Total cap</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-100">
              ${totalCap.toFixed(2)}
              <span className="ml-1 text-xs font-normal text-zinc-500">/month</span>
            </p>
          </div>
          <div className="ml-6">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Spent this month</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-100">
              ${totalSpent.toFixed(2)}
              <span className="ml-1 text-xs font-normal text-zinc-500">
                ({totalCap > 0 ? ((totalSpent / totalCap) * 100).toFixed(0) : 0}%)
              </span>
            </p>
          </div>
        </div>
      )}

      {/* Configured providers */}
      {loading ? (
        <p className="py-4 text-center text-xs text-zinc-600">Loading…</p>
      ) : (
        <div className="space-y-2">
          {breakdown.map((pb) => (
            <ProviderLimitRow
              key={pb.provider}
              pb={pb}
              saving={saving}
              onSave={saveCap}
            />
          ))}

          {/* Unconfigured providers */}
          {unconfigured.map((provider) => (
            <AddLimitRow
              key={provider}
              provider={provider}
              saving={saving}
              onSave={saveCap}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ProviderLimitRow ─────────────────────────────────────────────────────────

function ProviderLimitRow({
  pb, saving, onSave,
}: {
  pb: ProviderBudget
  saving: boolean
  onSave: (provider: Provider, capUsd: number) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value,   setValue]   = useState(String(pb.capUsd))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (!editing) setValue(String(pb.capUsd))
  }, [pb.capUsd, editing])

  async function commit() {
    const num = parseFloat(value)
    if (!isNaN(num) && num >= 0 && num !== pb.capUsd) {
      await onSave(pb.provider, num)
    }
    setEditing(false)
  }

  const pct  = pb.capUsd > 0 ? Math.min(100, pb.percentUsed) : 0
  const left = pb.capUsd > 0 ? Math.max(0, pb.capUsd - pb.spentUsd) : null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-zinc-200">{PROVIDER_LABELS[pb.provider]}</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            ${pb.spentUsd.toFixed(2)} spent
            {left !== null && (
              <span className={cn(
                'ml-1.5',
                left <= 0 ? 'text-red-400' : left < pb.capUsd * 0.1 ? 'text-orange-400' : 'text-emerald-400',
              )}>
                · ${left.toFixed(2)} remaining
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {editing ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500">$</span>
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
                  if (e.key === 'Escape') { setValue(String(pb.capUsd)); setEditing(false) }
                }}
                disabled={saving}
                className="w-20 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-400 disabled:opacity-40"
              />
              <span className="text-xs text-zinc-500">/mo</span>
            </div>
          ) : (
            <>
              <span className="text-xs text-zinc-400 tabular-nums">${pb.capUsd.toFixed(2)}/mo</span>
              <button
                onClick={() => { setValue(String(pb.capUsd)); setEditing(true) }}
                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => void onSave(pb.provider, 0)}
                disabled={saving}
                className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-600 hover:border-red-800 hover:text-red-400 transition-colors disabled:opacity-40"
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className={cn('h-full rounded-full transition-all duration-500', usageColor(pb.percentUsed))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ─── AddLimitRow ──────────────────────────────────────────────────────────────

function AddLimitRow({
  provider, saving, onSave,
}: {
  provider: Provider
  saving: boolean
  onSave: (provider: Provider, capUsd: number) => Promise<void>
}) {
  const [open,  setOpen]  = useState(false)
  const [value, setValue] = useState('')

  async function handleAdd() {
    const num = parseFloat(value)
    if (isNaN(num) || num <= 0) return
    await onSave(provider, num)
    setValue('')
    setOpen(false)
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-dashed border-zinc-800 px-4 py-2.5">
      <p className="text-xs text-zinc-600">{PROVIDER_LABELS[provider]}</p>

      {open ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">$</span>
          <input
            type="number"
            min="1"
            step="1"
            placeholder="20"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd()
              if (e.key === 'Escape') setOpen(false)
            }}
            autoFocus
            disabled={saving}
            className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-400 disabled:opacity-40"
          />
          <span className="text-xs text-zinc-500">/mo</span>
          <button
            onClick={() => void handleAdd()}
            disabled={saving || !value}
            className="rounded bg-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 transition-colors"
          >
            {saving ? '…' : 'Set'}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          + Set limit
        </button>
      )}
    </div>
  )
}
