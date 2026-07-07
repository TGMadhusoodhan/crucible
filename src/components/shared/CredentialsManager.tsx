'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Provider } from '@/types'

interface CliBackendStatus { available: boolean; version?: string; loggedIn?: boolean; reason?: string }
interface CliStatusData { inDocker: boolean; claudeCode: CliBackendStatus; codex: CliBackendStatus }

// AI providers shown in the main credentials list
const AI_PROVIDERS: Provider[] = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together', 'zai']

// Providers hidden from the "add key" UI — adapters still work, existing
// stored credentials still display so users can remove them if needed.
const HIDDEN_PROVIDERS = new Set<Provider>(['mistral', 'openrouter', 'together'])

type CredentialProvider = Provider | 'github'

const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  anthropic:     'Anthropic (Claude)',
  openai:        'OpenAI (GPT)',
  deepseek:      'DeepSeek',
  google:        'Google (Gemini)',
  mistral:       'Mistral / Codestral',
  openrouter:    'OpenRouter (any model)',
  groq:          'Groq',
  together:      'Together AI',
  zai:           'Z.ai (GLM)',
  github:        'GitHub',
  'claude-code': 'Claude Code (subscription)',
  codex:         'Codex (subscription)',
}

const PROVIDER_KEY_HINT: Partial<Record<CredentialProvider, string>> = {
  anthropic:  'sk-ant-…',
  openai:     'sk-…',
  deepseek:   'sk-…',
  google:     'AIza…',
  openrouter: 'sk-or-…',
  zai:        'your-api-key',
  github:     'github_pat_… or ghp_…',
}

interface Credential { id: string; provider: string; isValid: boolean; createdAt: number; login?: string }

interface AddKeyModalProps {
  provider: CredentialProvider
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

function GitHubCredential({
  cred,
  onAdd,
  onDelete,
}: {
  cred:     Credential | undefined
  onAdd:    () => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="mt-8 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">GitHub</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Connect a fine-grained Personal Access Token to push accepted files to your GitHub repos.
        </p>
      </div>

      {/* Setup instructions */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 space-y-1.5 text-[11px] text-zinc-500">
        <p className="font-medium text-zinc-400">How to create a fine-grained PAT:</p>
        <ol className="ml-3 list-decimal space-y-1">
          <li>Go to <span className="font-mono text-zinc-400">github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens</span></li>
          <li>Set expiration, then under <span className="font-mono text-zinc-400">Repository access</span> choose the repos Crucible can push to</li>
          <li>Under <span className="font-mono text-zinc-400">Permissions → Repository permissions</span>: set <span className="font-mono text-zinc-400">Contents → Read and write</span></li>
          <li>Add <span className="font-mono text-zinc-400">Administration → Read and write</span> only if you want Crucible to create new repos</li>
        </ol>
      </div>

      {/* Credential row */}
      <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            cred?.isValid ? 'bg-emerald-500' :
            cred          ? 'bg-red-500' :
                            'bg-zinc-700',
          )} />
          <div>
            <p className="text-sm font-medium text-zinc-200">GitHub PAT</p>
            <p className="text-[11px] text-zinc-600">
              {cred?.isValid && cred.login
                ? `@${cred.login} · connected ${new Date(cred.createdAt).toLocaleDateString()}`
                : cred?.isValid
                ? `Connected · ${new Date(cred.createdAt).toLocaleDateString()}`
                : cred
                ? 'Token invalid — click Update to replace'
                : 'Not connected'}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onAdd}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            {cred ? 'Update' : 'Connect'}
          </button>
          {cred && (
            <button
              onClick={() => onDelete(cred.id)}
              className="rounded border border-zinc-800 px-3 py-1.5 text-xs text-zinc-600 hover:border-red-800 hover:text-red-500 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CliBackendRow({
  label,
  subtitle,
  status,
  setupNote,
}: {
  label:     string
  subtitle:  string
  status:    CliBackendStatus | null
  setupNote: string
}) {
  const dot = !status
    ? 'bg-zinc-700'
    : status.loggedIn
    ? 'bg-emerald-500'
    : status.available
    ? 'bg-amber-500'
    : 'bg-zinc-700'

  const statusLine = !status
    ? 'Checking…'
    : status.loggedIn
    ? `Connected · ${status.version ?? ''}`
    : status.available
    ? (status.reason ?? 'Not authenticated')
    : (status.reason ?? 'Not installed')

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', dot)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-200">{label}</p>
          <p className="text-[11px] text-zinc-500">{subtitle}</p>
          <p className="mt-1 text-[11px] text-zinc-600">{statusLine}</p>
          {status && !status.loggedIn && (
            <p className="mt-1 font-mono text-[11px] text-zinc-500">{setupNote}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function CliSubscriptionsSection() {
  const [data, setData] = useState<CliStatusData | null>(null)

  useEffect(() => {
    fetch('/api/cli/status')
      .then(r => r.json())
      .then((res: { success: boolean; data?: CliStatusData }) => {
        if (res.success && res.data) setData(res.data)
      })
      .catch(() => {})
  }, [])

  if (data?.inDocker) {
    return (
      <div className="mt-8 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Subscription CLIs</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Claude Code and Codex subscription backends are not available inside Docker. Run Crucible natively to use them.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-8 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Subscription CLIs (R1 / R2 only)</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Use your Claude Pro/Max or ChatGPT plan as a reviewer — no API key required. These can only be selected as R1 or R2, never as the primary coder.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/40 px-4 py-3 text-[11px] text-zinc-400 space-y-1">
        <p className="font-medium text-zinc-300">Important caveats:</p>
        <ul className="ml-3 space-y-0.5 list-disc">
          <li>Each call starts a fresh CLI agent — expect 2–5s overhead vs. direct API</li>
          <li>Draws from your plan's interactive token window (Claude: 5-hour; Codex: 5-hour)</li>
          <li>Anthropic paused (not cancelled) separate metering — terms may change</li>
          <li>Crucible never sees your credentials — it spawns your own logged-in CLIs</li>
        </ul>
      </div>

      <div className="space-y-2">
        <CliBackendRow
          label="Claude Code (subscription)"
          subtitle="Reviewer via your Claude Pro/Max plan · claude-code-default"
          status={data?.claudeCode ?? null}
          setupNote="$ claude login"
        />
        <CliBackendRow
          label="Codex (subscription)"
          subtitle="Reviewer via your ChatGPT plan · codex-default"
          status={data?.codex ?? null}
          setupNote="$ codex login"
        />
      </div>
    </div>
  )
}

export function CredentialsManager() {
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading]         = useState(true)
  const [adding, setAdding]           = useState<CredentialProvider | null>(null)

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
          {AI_PROVIDERS.filter((provider) => !HIDDEN_PROVIDERS.has(provider) || connectedMap.has(provider)).map((provider) => {
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

      {/* ─── GitHub section ──────────────────────────────────────────────────── */}
      {!loading && <GitHubCredential cred={connectedMap.get('github')} onAdd={() => setAdding('github')} onDelete={handleDelete} />}

      {/* ─── CLI subscription section ─────────────────────────────────────────── */}
      {!loading && <CliSubscriptionsSection />}

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
