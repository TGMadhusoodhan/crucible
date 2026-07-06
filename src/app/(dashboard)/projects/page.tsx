'use client'

import { useEffect, useState } from 'react'
import type { ProjectContext } from '@/types'

interface Project {
  id:              string
  name:            string
  description:     string
  r1Provider:      string
  r1ModelId:       string
  r2Provider:      string
  r2ModelId:       string
  createdAt:       number
  workspaceDir:    string | null
  githubRepo:      string | null
  githubPushMode:  string | null
  githubBranch:    string | null
}

function Badge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300">{value}</span>
    </span>
  )
}

function DriftNotice({ files }: { files: string[] }) {
  if (files.length === 0) return null
  return (
    <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2">
      <p className="text-xs font-semibold text-amber-400">
        ⚠ {files.length} file{files.length > 1 ? 's' : ''} edited outside Crucible
      </p>
      <ul className="mt-1 space-y-0.5">
        {files.map(f => (
          <li key={f} className="font-mono text-xs text-amber-300/80">{f}</li>
        ))}
      </ul>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function CrucibleMdPanel({ md }: { md: string }) {
  const lines  = md.split('\n')
  const blocks: { type: 'h1' | 'h2' | 'h3' | 'text' | 'hr'; content: string }[] = []
  for (const line of lines) {
    if (line.startsWith('<!-- crucible:')) continue   // strip marker lines
    if (line.startsWith('# '))       blocks.push({ type: 'h1',  content: line.slice(2) })
    else if (line.startsWith('## ')) blocks.push({ type: 'h2',  content: line.slice(3) })
    else if (line.startsWith('### '))blocks.push({ type: 'h3',  content: line.slice(4) })
    else if (line === '---')         blocks.push({ type: 'hr',  content: '' })
    else                             blocks.push({ type: 'text', content: line })
  }

  return (
    <div className="space-y-1 text-sm text-zinc-300">
      {blocks.map((b, i) => {
        if (b.type === 'h1')   return <h1  key={i} className="mt-2 text-lg font-bold text-zinc-100">{b.content}</h1>
        if (b.type === 'h2')   return <h2  key={i} className="mt-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">{b.content}</h2>
        if (b.type === 'h3')   return <h3  key={i} className="mt-2 text-sm font-medium text-zinc-300">{b.content}</h3>
        if (b.type === 'hr')   return <hr  key={i} className="border-zinc-800" />
        if (!b.content.trim()) return <div key={i} className="h-1" />
        // Escape HTML first, then apply safe bold/code/bullet substitutions
        const rendered = escapeHtml(b.content)
          .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-zinc-200">$1</strong>')
          .replace(/`([^`]+)`/g, '<code class="rounded bg-zinc-800 px-1 text-xs text-emerald-400">$1</code>')
          .replace(/^- /, '• ')
        return (
          <p key={i}
            className="leading-relaxed text-zinc-400"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        )
      })}
    </div>
  )
}

function DecisionLog({ decisions }: { decisions: ProjectContext['decisions'] }) {
  if (decisions.length === 0) return <p className="text-xs text-zinc-500">No decisions recorded yet.</p>
  return (
    <ul className="space-y-2">
      {decisions.map((d, i) => (
        <li key={i} className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 text-base leading-none">
              {d.source === 'human' ? '👤' : d.source === 'arbitration' ? '⚖️' : '🤖'}
            </span>
            <div className="min-w-0">
              <p className="text-xs text-zinc-400">{d.questionText}</p>
              <p className="mt-0.5 text-xs font-medium text-zinc-200">→ {d.answer}</p>
              <p className="mt-0.5 text-[10px] text-zinc-600">{d.timestamp.slice(0, 10)}</p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function FileIndex({ entries }: { entries: ProjectContext['fileIndex'] }) {
  if (entries.length === 0) return <p className="text-xs text-zinc-500">No files accepted yet.</p>
  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900">
            <th className="px-3 py-2 text-left font-medium text-zinc-400">File</th>
            <th className="px-3 py-2 text-left font-medium text-zinc-400">Purpose</th>
            <th className="px-3 py-2 text-left font-medium text-zinc-400">Key Exports</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} className="border-b border-zinc-800/50 last:border-0">
              <td className="px-3 py-2 font-mono text-emerald-400">{e.filename}</td>
              <td className="px-3 py-2 text-zinc-400">{e.summary}</td>
              <td className="px-3 py-2 font-mono text-zinc-500">{e.exports.slice(0, 4).join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GitHubSettings({
  projectId,
  project,
  onSaved,
}: {
  projectId: string
  project:   Project | undefined
  onSaved:   () => void
}) {
  const [repo,     setRepo]     = useState(project?.githubRepo     ?? '')
  const [mode,     setMode]     = useState(project?.githubPushMode ?? 'off')
  const [branch,   setBranch]   = useState(project?.githubBranch   ?? 'main')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName,  setNewName]  = useState('')
  const [creating2,setCreating2]= useState(false)
  const [createErr,setCreateErr]= useState('')

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(''); setSuccess(false)
    try {
      const res  = await fetch(`/api/projects/${projectId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ githubRepo: repo.trim() || null, githubPushMode: mode, githubBranch: branch.trim() || 'main' }),
      })
      const data = await res.json() as { success: boolean; error?: string }
      if (data.success) { setSuccess(true); onSaved() }
      else setError(data.error ?? 'Save failed')
    } catch { setError('Network error') }
    finally { setSaving(false) }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating2(true); setCreateErr('')
    try {
      const res  = await fetch('/api/github/repos', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim() }),
      })
      const data = await res.json() as { success: boolean; data?: { fullName: string }; error?: string }
      if (data.success && data.data?.fullName) {
        setRepo(data.data.fullName)
        setCreating(false)
        setNewName('')
      } else {
        setCreateErr(data.error ?? 'Failed to create repo')
      }
    } catch { setCreateErr('Network error') }
    finally { setCreating2(false) }
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium text-zinc-300">GitHub push settings</p>
        <p className="mt-0.5 text-[11px] text-zinc-600">
          Push accepted files to a GitHub repo automatically.{' '}
          Requires a GitHub PAT in Settings → API Keys.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-zinc-400">Repository (owner/name)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={repo}
              onChange={e => setRepo(e.target.value)}
              placeholder="owner/repo-name"
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-zinc-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setCreating(c => !c)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              + New repo
            </button>
          </div>
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="rounded border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
            <p className="text-[11px] text-zinc-500">Create a new private GitHub repo:</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="my-project"
                className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-zinc-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!newName.trim() || creating2}
                className="rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 transition-colors"
              >
                {creating2 ? 'Creating…' : 'Create'}
              </button>
            </div>
            {createErr && <p className="text-[11px] text-red-400">{createErr}</p>}
          </form>
        )}

        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-zinc-400">Branch</label>
          <input
            type="text"
            value={branch}
            onChange={e => setBranch(e.target.value)}
            placeholder="main"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-zinc-500 focus:outline-none"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-zinc-400">Push mode</label>
          <div className="space-y-1.5">
            {([
              ['off',         'Off — no automatic push'],
              ['per_file',    'Per file — push after each accepted file'],
              ['per_session', 'Per session — push once when session completes'],
            ] as const).map(([val, label]) => (
              <label key={val} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="pushMode"
                  value={val}
                  checked={mode === val}
                  onChange={() => setMode(val)}
                  className="accent-blue-500"
                />
                <span className="text-xs text-zinc-400">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {error   && <p className="text-[11px] text-red-400">{error}</p>}
        {success && <p className="text-[11px] text-emerald-400">Saved</p>}

        <button
          type="submit"
          disabled={saving}
          className="rounded bg-zinc-700 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      {/* Manual push */}
      {project?.githubRepo && project.workspaceDir && (
        <ManualPushButton projectId={projectId} repo={project.githubRepo} />
      )}
    </div>
  )
}

function ManualPushButton({ projectId, repo }: { projectId: string; repo: string }) {
  const [pushing, setPushing] = useState(false)
  const [result,  setResult]  = useState<{ sha: string; url: string } | null>(null)
  const [error,   setError]   = useState('')

  async function handlePush() {
    setPushing(true); setResult(null); setError('')
    try {
      const res  = await fetch(`/api/projects/${projectId}/push`, { method: 'POST' })
      const data = await res.json() as { success: boolean; data?: { sha: string; branch: string; url: string }; error?: string }
      if (data.success && data.data) setResult(data.data)
      else setError(data.error ?? 'Push failed')
    } catch { setError('Network error') }
    finally { setPushing(false) }
  }

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-2">
      <p className="text-[11px] text-zinc-500">Manual push of workspace to <span className="font-mono text-zinc-400">{repo}</span>:</p>
      <button
        onClick={handlePush}
        disabled={pushing}
        className="rounded border border-zinc-700 px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
      >
        {pushing ? 'Pushing…' : 'Push now'}
      </button>
      {result && (
        <p className="text-[11px] text-emerald-400">
          Pushed{' '}
          <a href={result.url} target="_blank" rel="noopener noreferrer" className="underline font-mono">
            {result.sha.slice(0, 7)}
          </a>
        </p>
      )}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  )
}

export default function ProjectsPage() {
  const [projects, setProjects]       = useState<Project[]>([])
  const [selected, setSelected]       = useState<string | null>(null)
  const [context, setContext]         = useState<ProjectContext | null>(null)
  const [ctxLoading, setCtxLoading]   = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [activeTab, setActiveTab]     = useState<'overview' | 'decisions' | 'files' | 'github'>('overview')

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json() as Promise<{ success: boolean; data?: Project[] }>)
      .then(d => { if (d.success && d.data) setProjects(d.data) })
      .catch(() => {})
      .finally(() => setListLoading(false))
  }, [])

  function selectProject(id: string) {
    setSelected(id)
    setContext(null)
    setCtxLoading(true)
    setActiveTab('overview')
    fetch(`/api/projects/${id}/context`)
      .then(r => r.json() as Promise<{ success: boolean; data?: ProjectContext }>)
      .then(d => { if (d.success && d.data) setContext(d.data) })
      .catch(() => {})
      .finally(() => setCtxLoading(false))
  }

  const selectedProject = projects.find(p => p.id === selected)

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ─── Project list ─────────────────────────────────────────────────── */}
      <div className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-200">Projects</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {listLoading && (
            <p className="px-2 py-3 text-xs text-zinc-500">Loading…</p>
          )}
          {!listLoading && projects.length === 0 && (
            <p className="px-2 py-3 text-xs text-zinc-500">No projects yet.</p>
          )}
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => selectProject(p.id)}
              className={[
                'w-full rounded px-3 py-2.5 text-left transition-colors',
                selected === p.id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
              ].join(' ')}
            >
              <p className="truncate text-sm font-medium">{p.name}</p>
              {p.workspaceDir && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600" title={p.workspaceDir}>
                  {p.workspaceDir.replace(/^.*[/\\]/, '…/')}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Context panel ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {!selected && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-zinc-600">Select a project to view its memory</p>
          </div>
        )}

        {selected && (
          <>
            {/* Header */}
            <div className="border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <h1 className="text-base font-semibold text-zinc-100">{selectedProject?.name}</h1>
                {context && (
                  <span className={[
                    'rounded px-2 py-0.5 text-xs font-medium',
                    context.mode === 'continue'
                      ? 'bg-emerald-900/40 text-emerald-400'
                      : 'bg-zinc-800 text-zinc-400',
                  ].join(' ')}>
                    {context.mode === 'continue' ? 'Continuing' : 'New'}
                  </span>
                )}
              </div>
              {selectedProject?.description && (
                <p className="mt-0.5 text-xs text-zinc-500">{selectedProject.description}</p>
              )}
              {selectedProject && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge label="R1" value={`${selectedProject.r1Provider}/${selectedProject.r1ModelId}`} />
                  <Badge label="R2" value={`${selectedProject.r2Provider}/${selectedProject.r2ModelId}`} />
                </div>
              )}
            </div>

            {ctxLoading && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs text-zinc-500">Loading project memory…</p>
              </div>
            )}

            {!ctxLoading && context && (
              <div className="flex flex-1 flex-col overflow-hidden">
                {/* Drift notice */}
                {context.driftedFiles.length > 0 && (
                  <div className="px-6 pt-4">
                    <DriftNotice files={context.driftedFiles} />
                  </div>
                )}

                {/* Tabs */}
                <div className="flex gap-0 border-b border-zinc-800 px-6">
                  {(['overview', 'decisions', 'files', 'github'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={[
                        'border-b-2 px-4 py-2.5 text-xs font-medium capitalize transition-colors',
                        activeTab === tab
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-zinc-500 hover:text-zinc-300',
                      ].join(' ')}
                    >
                      {tab}
                      {tab === 'decisions' && context.decisions.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                          {context.decisions.length}
                        </span>
                      )}
                      {tab === 'files' && context.fileIndex.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                          {context.fileIndex.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-y-auto px-6 py-4">
                  {activeTab === 'overview' && (
                    <div>
                      {context.crucibleMd ? (
                        <CrucibleMdPanel md={context.crucibleMd} />
                      ) : (
                        <p className="text-xs text-zinc-500">
                          No CRUCIBLE.md yet. Start a pipeline session to generate project memory.
                        </p>
                      )}
                      {context.specSummary && (
                        <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                          <p className="text-xs font-medium text-zinc-400">Prior spec</p>
                          <p className="mt-1 text-xs text-zinc-300">{context.specSummary}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {activeTab === 'decisions' && <DecisionLog decisions={context.decisions} />}
                  {activeTab === 'files' && <FileIndex entries={context.fileIndex} />}
                  {activeTab === 'github' && selected && (
                    <GitHubSettings projectId={selected} project={selectedProject} onSaved={() => {
                      // Refresh project list to pick up new githubRepo/pushMode/branch
                      fetch('/api/projects')
                        .then(r => r.json() as Promise<{ success: boolean; data?: Project[] }>)
                        .then(d => { if (d.success && d.data) setProjects(d.data) })
                        .catch(() => {})
                    }} />
                  )}
                </div>
              </div>
            )}

            {!ctxLoading && !context && !selectedProject?.workspaceDir && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs text-zinc-500">
                  No workspace linked to this project. Edit the project to link a local folder.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
