'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Provider } from '@/types'

const PROVIDERS: Provider[] = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together']

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic:  'Anthropic (Claude)',
  openai:     'OpenAI (GPT)',
  deepseek:   'DeepSeek',
  google:     'Google (Gemini)',
  mistral:    'Mistral / Codestral',
  openrouter: 'OpenRouter (any model)',
  groq:       'Groq',
  together:   'Together AI',
}

const PROVIDER_KEY_HINT: Partial<Record<Provider, string>> = {
  anthropic:  'sk-ant-…',
  openai:     'sk-…',
  deepseek:   'sk-…',
  google:     'AIza…',
  openrouter: 'sk-or-…',
}

interface Credential { id: string; provider: string; isValid: boolean; createdAt: number }

interface AddKeyModalProps {
  provider: Provider
  onClose: () => void
  onSaved: () => void
}

function AddKeyModal({ provider, onClose, onSaved }: AddKeyModalProps) {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed) return

    setSaving(true)
    setError('')

    try {
      const res  = await fetch('/api/credentials', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider, apiKey: trimmed }),
      })
      const data = await res.json() as { success: boolean; error?: string }

      if (data.success) {
        onSaved()
      } else {
        setError(data.error ?? 'Failed to save key')
        setSaving(false)
      }
    } catch {
      setError('Network error — is the server running?')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <h3 className="mb-1 text-sm font-semibold text-zinc-100">{PROVIDER_LABELS[provider]}</h3>
        <p className="mb-4 text-xs text-zinc-500">
          Key will be validated against the provider before saving.
          Stored encrypted with AES-256-GCM — never in plaintext.
        </p>

        <form onSubmit={handleSave} className="space-y-4">
          <input
            type="password"
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-400 transition-colors"
            placeholder={PROVIDER_KEY_HINT[provider] ?? 'Paste your API key…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />

          {error && (
            <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded border border-zinc-700 py-2 text-sm text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!apiKey.trim() || saving}
              className="flex-1 rounded bg-zinc-100 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-40 transition-colors"
            >
              {saving ? 'Validating…' : 'Save key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function CredentialsManager() {
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading]         = useState(true)
  const [adding, setAdding]           = useState<Provider | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/credentials')
      const data = await res.json() as { success: boolean; data?: Credential[] }
      if (data.success && data.data) setCredentials(data.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleDelete(id: string) {
    await fetch(`/api/credentials/${id}`, { method: 'DELETE' })
    await load()
  }

  const connectedMap = new Map(credentials.map((c) => [c.provider, c]))

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">API Keys</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Connect the providers you want to use. You need at least one for the primary coder
          and one for the reviewer (ideally from different families).
        </p>
      </div>

      {/* Recommended pairing hint */}
      <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/40 px-4 py-3 text-xs text-zinc-400">
        <span className="font-medium text-zinc-300">Recommended default:</span>{' '}
        <span className="font-mono">DeepSeek</span> as primary coder +{' '}
        <span className="font-mono">Anthropic</span> as reviewer — different training families = genuine blind spot coverage, ~36× cheaper than all-Claude.
      </div>

      {loading ? (
        <p className="text-sm text-zinc-600">Loading…</p>
      ) : (
        <div className="space-y-2">
          {PROVIDERS.map((provider) => {
            const cred = connectedMap.get(provider)
            return (
              <div
                key={provider}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  {/* Status dot */}
                  <span className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    cred?.isValid ? 'bg-emerald-500' :
                    cred          ? 'bg-red-500' :
                                    'bg-zinc-700',
                  )} />
                  <div>
                    <p className="text-sm font-medium text-zinc-200">{PROVIDER_LABELS[provider]}</p>
                    <p className="text-[11px] text-zinc-600">
                      {cred?.isValid
                        ? `Connected · ${new Date(cred.createdAt).toLocaleDateString()}`
                        : cred
                        ? 'Key invalid — click Update to replace'
                        : 'Not connected'}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => setAdding(provider)}
                    className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    {cred ? 'Update' : 'Connect'}
                  </button>
                  {cred && (
                    <button
                      onClick={() => void handleDelete(cred.id)}
                      className="rounded border border-zinc-800 px-3 py-1.5 text-xs text-zinc-600 hover:border-red-800 hover:text-red-500 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {adding && (
        <AddKeyModal
          provider={adding}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); void load() }}
        />
      )}
    </div>
  )
}
