'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { usePipelineDispatch, usePipelineState } from '@/store'
import { usePipeline } from '@/hooks/usePipeline'
import { cn } from '@/lib/utils'
import type { ConsensusOutput, Provider, SpecDocument } from '@/types'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'mistral', 'openrouter', 'groq', 'together', 'zai', 'claude-code', 'codex'] as const

const HIDDEN_PROVIDERS = new Set<Provider>(['mistral', 'openrouter', 'together'])

// CLI providers authenticate via the user's local CLI — no API key stored in Crucible
const CLI_PROVIDERS = new Set<Provider>(['claude-code', 'codex'])

// ─── Model catalogue ──────────────────────────────────────────────────────────

interface ModelOption {
  id:           string
  label:        string
  recommended?: boolean
  note?:        string
}

const PROVIDER_MODELS: Record<Provider, ModelOption[]> = {
  deepseek: [
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro',   recommended: true, note: '80.6% SWE-bench · best coder' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash',  note: 'fast & cheap' },
    { id: 'deepseek-chat',     label: 'DeepSeek V3 Chat',   note: 'V3 fallback' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1',        note: 'reasoning model' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6', recommended: true, note: 'best reviewer' },
    { id: 'claude-opus-4-8',            label: 'Claude Opus 4.8',   note: 'most capable' },
    { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',  note: 'fast & cheap' },
  ],
  openai: [
    { id: 'gpt-4o',      label: 'GPT-4o',       recommended: true },
    { id: 'gpt-5-4',     label: 'GPT-5.4' },
    { id: 'gpt-5-5',     label: 'GPT-5.5',      note: 'most capable' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini',  note: 'fast & cheap' },
  ],
  google: [
    { id: 'gemini-pro',         label: 'Gemini Pro',         recommended: true },
    { id: 'gemini-flash',       label: 'Gemini Flash',       note: 'fast' },
    { id: 'gemini-2.0-flash',   label: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro',     label: 'Gemini 1.5 Pro' },
  ],
  mistral: [
    { id: 'mistral-large', label: 'Mistral Large',    recommended: true },
    { id: 'codestral',     label: 'Codestral',        note: 'coding specialist' },
    { id: 'mistral-small', label: 'Mistral Small',    note: 'fast' },
  ],
  openrouter: [
    { id: 'openai/gpt-4o',                    label: 'GPT-4o',               recommended: true },
    { id: 'anthropic/claude-sonnet-4-6',      label: 'Claude Sonnet 4.6' },
    { id: 'deepseek/deepseek-v4-pro',         label: 'DeepSeek V4 Pro' },
    { id: 'meta-llama/llama-3.1-405b',        label: 'Llama 3.1 405B' },
    { id: 'google/gemini-pro',                label: 'Gemini Pro' },
    { id: 'mistralai/mistral-large',          label: 'Mistral Large' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', recommended: true },
    { id: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B' },
    { id: 'mixtral-8x7b-32768',      label: 'Mixtral 8x7B' },
    { id: 'gemma2-9b-it',            label: 'Gemma 2 9B',   note: 'fast' },
  ],
  together: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct',    label: 'Llama 3.3 70B',    recommended: true },
    { id: 'meta-llama/Llama-3.1-70B-Instruct',    label: 'Llama 3.1 70B' },
    { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct',      label: 'Qwen 2.5 Coder 32B', note: 'coding' },
  ],
  zai: [
    { id: 'glm-5.2',       label: 'GLM-5.2',        recommended: true, note: 'flagship' },
    { id: 'glm-5-turbo',   label: 'GLM-5 Turbo',    note: 'fast' },
    { id: 'glm-4.7-flash', label: 'GLM-4.7 Flash',  note: 'free tier' },
  ],
  'claude-code': [
    { id: 'claude-code-default', label: 'Claude Code (subscription)', recommended: true, note: 'model follows your CLI config' },
  ],
  codex: [
    { id: 'codex-default', label: 'Codex (subscription)', recommended: true, note: 'model follows your CLI config' },
  ],
}

function defaultModelId(provider: Provider): string {
  return PROVIDER_MODELS[provider].find((m) => m.recommended)?.id
    ?? PROVIDER_MODELS[provider][0]?.id
    ?? ''
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string
  name: string
  description: string
  r1Provider: Provider
  r1ModelId: string
  r2Provider: Provider
  r2ModelId: string
  createdAt: number
}

const CODER_PROVIDER = 'deepseek' as const
const CODER_MODEL_ID  = 'deepseek-v4-pro' as const

// ─── Main navigator ───────────────────────────────────────────────────────────

export function ProjectNavigator() {
  const dispatch              = usePipelineDispatch()
  const { project }           = usePipelineState()
  const [projects, setProjects]   = useState<Project[]>([])
  const [showNew, setShowNew]     = useState(false)
  const [deleting, setDeleting]   = useState<string | null>(null)

  const loadProjects = useCallback(async () => {
    const res = await fetch('/api/projects')
    if (res.ok) {
      const data = await res.json() as { success: boolean; data?: Project[] }
      if (data.success && data.data) setProjects(data.data)
    }
  }, [])

  useEffect(() => { void loadProjects() }, [loadProjects])

  function selectProject(p: Project) {
    dispatch({
      type: 'SELECT_PROJECT',
      project: {
        id:            p.id,
        name:          p.name,
        coderProvider: CODER_PROVIDER,
        coderModelId:  CODER_MODEL_ID,
        r1Provider:    p.r1Provider,
        r1ModelId:     p.r1ModelId,
        r2Provider:    p.r2Provider,
        r2ModelId:     p.r2ModelId,
      },
    })
    // Fetch the last stored output from the server (survives restarts, any device).
    fetch(`/api/projects/${p.id}/output`)
      .then((r) => r.json() as Promise<{ success: boolean; data?: { output: ConsensusOutput; spec: SpecDocument | null } | null }>)
      .then((data) => {
        if (data.success && data.data?.output) {
          dispatch({ type: 'RESTORE_OUTPUT', output: data.data.output, spec: data.data.spec ?? null })
        }
      })
      .catch(() => { /* no stored output — fresh project, nothing to restore */ })
  }

  async function deleteProject(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    if (!window.confirm('Delete this project?')) return
    setDeleting(id)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (project?.id === id) dispatch({ type: 'CLEAR_PROJECT' })
      await loadProjects()
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="flex h-full flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <span className="text-xs font-semibold text-zinc-300">Projects</span>
        <button
          onClick={() => setShowNew(true)}
          className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 transition-colors"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {projects.length === 0 && (
          <div className="px-2 pt-6 text-center space-y-3">
            <p className="text-xs text-zinc-600">No projects yet.</p>
            <p className="text-[11px] text-zinc-700">
              First{' '}
              <Link href="/settings" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
                add your API keys
              </Link>
              , then create a project.
            </p>
          </div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            className={cn(
              'group flex items-center gap-1 rounded-r transition-colors border-l-2',
              p.id === project?.id
                ? 'bg-zinc-800/70 border-coder-600'
                : 'hover:bg-zinc-800/40 border-transparent',
            )}
          >
            <button
              onClick={() => selectProject(p)}
              className={cn(
                'min-w-0 flex-1 px-3 py-2 text-left',
                p.id === project?.id ? 'text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-300',
              )}
            >
              <p className="text-xs font-medium truncate">{p.name}</p>
              <p className="text-[10px] text-zinc-600 truncate">
                DeepSeek → {p.r1ModelId} + {p.r2ModelId}
              </p>
            </button>
            <button
              onClick={(e) => void deleteProject(e, p.id)}
              disabled={deleting === p.id}
              title="Delete project"
              className="mr-1 shrink-0 rounded p-1 text-zinc-700 opacity-0 group-hover:opacity-100 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={(created) => {
            setShowNew(false)
            void loadProjects()
            selectProject(created)  // auto-select the newly created project
          }}
        />
      )}
    </div>
  )
}

// ─── New project modal ────────────────────────────────────────────────────────

interface CredStatus { provider: string; isValid: boolean }

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [form, setForm] = useState({
    name:        '',
    description: '',
    r1Provider:  'anthropic' as Provider,
    r1ModelId:   defaultModelId('anthropic'),
    r2Provider:  'openai'    as Provider,
    r2ModelId:   defaultModelId('openai'),
  })
  const [saving,  setSaving] = useState(false)
  const [error,   setError]  = useState('')
  const [credMap, setCredMap] = useState<Record<string, boolean>>({})

  // Load which providers have valid keys so we can show ✓/✗
  useEffect(() => {
    fetch('/api/credentials')
      .then((r) => r.json() as Promise<{ success: boolean; data?: CredStatus[] }>)
      .then((d) => {
        if (d.success && d.data) {
          const map: Record<string, boolean> = {}
          d.data.forEach((c) => { map[c.provider] = c.isValid })
          setCredMap(map)
        }
      })
      .catch(() => { /* non-blocking */ })
  }, [])

  function setR1Provider(provider: Provider) {
    setForm((f) => ({ ...f, r1Provider: provider, r1ModelId: defaultModelId(provider) }))
  }

  function setR2Provider(provider: Provider) {
    setForm((f) => ({ ...f, r2Provider: provider, r2ModelId: defaultModelId(provider) }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    if (form.r1Provider === form.r2Provider) {
      setError('Reviewers must use different providers')
      return
    }
    setSaving(true)
    const res  = await fetch('/api/projects', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(form),
    })
    const data = await res.json() as { success: boolean; data?: Project; error?: string }
    if (data.success && data.data) {
      onCreated(data.data)
    } else {
      setError(data.error ?? 'Failed to create project')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
        <h2 className="mb-1 text-sm font-semibold text-zinc-100">New project</h2>
        <p className="mb-4 text-xs text-zinc-500">
          DeepSeek generates code. Reviewer 1 and Reviewer 2 independently review and
          provide fixes. Conflicting fixes are resolved between the reviewers before
          DeepSeek applies the agreed-upon changes.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Project name">
            <input
              className={INPUT_CLS}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="My project"
              autoFocus
            />
          </Field>

          {/* Coder — fixed to DeepSeek */}
          <div className="rounded-lg border border-zinc-800 overflow-hidden flex">
            <div className="w-0.5 shrink-0 bg-coder-600" />
            <div className="flex-1 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  DeepSeek — code generator
                </p>
                <KeyBadge provider={CODER_PROVIDER} credMap={credMap} />
              </div>
              <p className="text-[10px] text-zinc-600">
                Fixed to {CODER_MODEL_ID}. Used for all code generation and patch application.
              </p>
            </div>
          </div>

          {/* Reviewer 1 */}
          <div className="rounded-lg border border-zinc-800 overflow-hidden flex">
            <div className="w-0.5 shrink-0 bg-reviewer-600" />
            <div className="flex-1 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Reviewer 1
                </p>
                <KeyBadge provider={form.r1Provider} credMap={credMap} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provider">
                  <ProviderSelect value={form.r1Provider} onChange={setR1Provider} />
                </Field>
                <Field label="Model">
                  <ModelSelect
                    provider={form.r1Provider}
                    value={form.r1ModelId}
                    onChange={(id) => setForm({ ...form, r1ModelId: id })}
                  />
                </Field>
              </div>
            </div>
          </div>

          {/* Reviewer 2 */}
          <div className="rounded-lg border border-zinc-800 overflow-hidden flex">
            <div className="w-0.5 shrink-0 bg-reviewer-400" />
            <div className="flex-1 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                  Reviewer 2
                </p>
                <KeyBadge provider={form.r2Provider} credMap={credMap} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provider">
                  <ProviderSelect value={form.r2Provider} onChange={setR2Provider} />
                </Field>
                <Field label="Model">
                  <ModelSelect
                    provider={form.r2Provider}
                    value={form.r2ModelId}
                    onChange={(id) => setForm({ ...form, r2ModelId: id })}
                  />
                </Field>
              </div>
              <p className="text-[10px] text-zinc-600">Must be a different provider from Reviewer 1</p>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded border border-zinc-700 py-2 text-sm text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded bg-zinc-100 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-40 transition-colors"
            >
              {saving ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

const INPUT_CLS = 'w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 cursor-pointer'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase tracking-wide">
        {label}
      </label>
      {children}
    </div>
  )
}

function KeyBadge({ provider, credMap }: { provider: Provider; credMap: Record<string, boolean> }) {
  if (CLI_PROVIDERS.has(provider)) {
    return (
      <span className="text-[10px] text-zinc-500">
        subscription · no API key needed
      </span>
    )
  }
  if (!(provider in credMap)) {
    return (
      <Link href="/settings" className="text-[10px] text-red-400 hover:underline">
        ✗ No key — add in Settings
      </Link>
    )
  }
  if (!credMap[provider]) {
    return (
      <Link href="/settings" className="text-[10px] text-orange-400 hover:underline">
        ⚠ Key invalid — update in Settings
      </Link>
    )
  }
  return (
    <span className="text-[10px] text-emerald-500">✓ Key connected</span>
  )
}

function ProviderSelect({ value, onChange }: { value: Provider; onChange: (v: Provider) => void }) {
  return (
    <select
      className={INPUT_CLS}
      value={value}
      onChange={(e) => onChange(e.target.value as Provider)}
    >
      {PROVIDERS.filter(p => !HIDDEN_PROVIDERS.has(p)).map((p) => (
        <option key={p} value={p}>{p}</option>
      ))}
    </select>
  )
}

function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: Provider
  value: string
  onChange: (id: string) => void
}) {
  const [liveModels, setLiveModels] = useState<string[]>([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')

  // Try to fetch real model IDs from the provider when it changes.
  // CLI providers use a fixed synthetic model id — skip the live fetch.
  useEffect(() => {
    if (CLI_PROVIDERS.has(provider)) {
      setLiveModels([])
      setLoading(false)
      return
    }
    setLiveModels([])
    setError('')
    setLoading(true)
    fetch(`/api/models/${provider}`)
      .then((r) => r.json() as Promise<{ success: boolean; data?: string[]; error?: string }>)
      .then((d) => {
        if (d.success && d.data?.length) setLiveModels(d.data)
        else setError(d.error ?? '')
      })
      .catch(() => setError(''))
      .finally(() => setLoading(false))
  }, [provider])

  // Sync the form value when live models load and the curated ID isn't in the list
  useEffect(() => {
    if (liveModels.length > 0 && !liveModels.includes(value)) {
      const first = liveModels[0]
      if (first) onChange(first)
    }
  }, [liveModels])   // eslint-disable-line react-hooks/exhaustive-deps

  const fallback = PROVIDER_MODELS[provider]

  // If live models loaded, show them; otherwise fall back to the curated list
  if (loading) {
    return (
      <select className={INPUT_CLS} disabled>
        <option>Loading models…</option>
      </select>
    )
  }

  if (liveModels.length > 0) {
    return (
      <select
        className={INPUT_CLS}
        value={liveModels.includes(value) ? value : liveModels[0]}
        onChange={(e) => onChange(e.target.value)}
      >
        {liveModels.map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>
    )
  }

  // Fallback to curated list (no API key yet, or provider didn't return models)
  return (
    <div>
      <select
        className={INPUT_CLS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {fallback.map((m) => (
          <option key={m.id} value={m.id}>
            {m.recommended ? '★ ' : ''}{m.label}{m.note ? ` — ${m.note}` : ''}
          </option>
        ))}
      </select>
      {error && (
        <p className="mt-1 text-[10px] text-zinc-600">
          {error.includes('No API key') ? 'Add API key in Settings to see live models' : 'Using preset list'}
        </p>
      )}
    </div>
  )
}
