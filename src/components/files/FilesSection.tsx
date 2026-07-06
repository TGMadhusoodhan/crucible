'use client'

import { useState, useEffect, useCallback, useId } from 'react'
import { usePipelineState } from '@/store'
import { cn } from '@/lib/utils'

interface FileEntry {
  path:        string
  size:        number
  updatedAt:   number
  inWorkspace: boolean
}

// ─── Tree builder ─────────────────────────────────────────────────────────────

type TreeNode = { children: Record<string, TreeNode> } | null

function buildTree(files: string[]): Record<string, TreeNode> {
  const root: Record<string, TreeNode> = {}
  for (const file of files) {
    const parts = file.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!
      if (!node[part] || node[part] === null) node[part] = { children: {} }
      node = (node[part] as { children: Record<string, TreeNode> }).children
    }
    node[parts[parts.length - 1]!] = null
  }
  return root
}

// ─── Extension color ──────────────────────────────────────────────────────────

function extColor(ext: string): string {
  if (['ts', 'tsx'].includes(ext)) return 'text-blue-400/80'
  if (['js', 'jsx'].includes(ext)) return 'text-yellow-500/80'
  if (['css', 'scss', 'sass'].includes(ext)) return 'text-pink-400/80'
  if (['json'].includes(ext))                return 'text-orange-400/80'
  if (ext === 'md')                          return 'text-zinc-500'
  if (ext === 'html')                        return 'text-red-400/80'
  return 'text-zinc-600'
}

// ─── Tree rows ────────────────────────────────────────────────────────────────

function TreeRows({
  nodes, depth, pathPrefix, activeFile, onSelect, ancestors = [], writtenFiles = new Set(),
}: {
  nodes:        Record<string, TreeNode>
  depth:        number
  pathPrefix:   string
  activeFile:   string | null
  onSelect:     (path: string) => void
  ancestors?:   boolean[]  // true = ancestor was last child at that depth
  writtenFiles?: Set<string>
}) {
  const entries = Object.entries(nodes)
  const [openSet, setOpenSet] = useState<Set<string>>(() => {
    const s = new Set<string>()
    entries.forEach(([name, node]) => { if (node !== null && depth < 2) s.add(name) })
    return s
  })

  return (
    <>
      {entries.map(([name, node], idx) => {
        const isLast    = idx === entries.length - 1
        const isDir     = node !== null
        const fullPath  = pathPrefix ? `${pathPrefix}/${name}` : name
        const isActive  = !isDir && activeFile === fullPath
        const ext       = isDir ? '' : (name.split('.').pop() ?? '')
        const isOpen    = isDir && openSet.has(name)
        const isWritten = !isDir && writtenFiles.has(fullPath)

        // Vertical pipe lines for parent levels
        const leadingChars = ancestors.map(wasLast => wasLast ? '   ' : '│  ').join('')
        const connector    = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ')
        const prefix       = leadingChars + connector

        return (
          <div key={name}>
            <button
              onClick={() => {
                if (isDir) {
                  setOpenSet(prev => {
                    const next = new Set(prev)
                    next.has(name) ? next.delete(name) : next.add(name)
                    return next
                  })
                } else {
                  onSelect(fullPath)
                }
              }}
              aria-current={isActive ? 'true' : undefined}
              aria-expanded={isDir ? isOpen : undefined}
              className={cn(
                'group flex w-full items-baseline gap-0 px-4 py-[3px] text-left transition-colors',
                'border-l-2',
                isActive
                  ? 'bg-zinc-800/60 border-indigo-500'
                  : 'border-transparent hover:bg-zinc-800/30',
              )}
            >
              {prefix && (
                <span className="shrink-0 select-none font-mono text-[10px] text-zinc-700 whitespace-pre" aria-hidden>
                  {prefix}
                </span>
              )}
              {isDir ? (
                <>
                  <span className="mr-1 shrink-0 font-mono text-[10px] text-zinc-600 select-none" aria-hidden>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className={cn('font-mono text-[11px] text-zinc-400 group-hover:text-zinc-200 transition-colors', isOpen && 'text-zinc-300')}>
                    {name}<span className="text-zinc-700">/</span>
                  </span>
                </>
              ) : (
                <>
                  <span className={cn('mr-0.5 shrink-0 font-mono text-[10px] select-none', extColor(ext))} aria-hidden>·</span>
                  <span className={cn('font-mono text-[11px] transition-colors truncate', isActive ? 'text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-200')}>
                    {name.replace(/\.[^.]+$/, '')}
                    <span className={cn('font-mono', extColor(ext))}>{ext ? `.${ext}` : ''}</span>
                  </span>
                  {isWritten && (
                    <span
                      className="ml-auto shrink-0 font-mono text-[8px] text-emerald-600 select-none"
                      title="Written to workspace"
                      aria-label="Written to workspace"
                    >
                      ✓
                    </span>
                  )}
                </>
              )}
            </button>

            {isDir && isOpen && (
              <TreeRows
                nodes={(node as { children: Record<string, TreeNode> }).children}
                depth={depth + 1}
                pathPrefix={fullPath}
                activeFile={activeFile}
                onSelect={onSelect}
                ancestors={[...ancestors, isLast]}
                writtenFiles={writtenFiles}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function FilesSection() {
  const { project, sessionId } = usePipelineState()
  const [files,        setFiles]        = useState<FileEntry[]>([])
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  const [activeFile,   setActiveFile]   = useState<string | null>(null)
  const [content,      setContent]      = useState<string | null>(null)
  const [commitHash,   setCommitHash]   = useState<string | null>(null)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [loading,      setLoading]      = useState(false)
  const [chatPrompt,   setChatPrompt]   = useState('')
  const [chatSending,  setChatSending]  = useState(false)
  const [chatError,    setChatError]    = useState<string | null>(null)
  const [downloaded,   setDownloaded]   = useState(false)
  const chatLabelId = useId()

  const projectId = project?.id

  const fetchFiles = useCallback(async () => {
    if (!projectId) return
    try {
      const res  = await fetch(`/api/files/${projectId}`)
      const data = await res.json() as { success: boolean; data?: { files: FileEntry[]; workspaceDir: string | null } }
      if (data.success && data.data) {
        setFiles(data.data.files)
        setWorkspaceDir(data.data.workspaceDir)
      }
    } catch { /* silent */ }
  }, [projectId])

  useEffect(() => {
    void fetchFiles()
    const id = setInterval(fetchFiles, 5000)
    return () => clearInterval(id)
  }, [fetchFiles])

  async function selectFile(filepath: string) {
    if (activeFile === filepath) return
    setActiveFile(filepath)
    setContent(null)
    setCommitHash(null)
    setWorkspacePath(null)
    setChatError(null)
    if (!projectId) return
    setLoading(true)
    try {
      const res  = await fetch(`/api/files/${projectId}/${filepath}`)
      const data = await res.json() as {
        success: boolean
        data?: { content: string; commitHash?: string | null; workspacePath?: string | null }
      }
      if (data.success && data.data) {
        setContent(data.data.content)
        setCommitHash(data.data.commitHash ?? null)
        setWorkspacePath(data.data.workspacePath ?? null)
      }
    } catch { /* silent */ } finally { setLoading(false) }
  }

  async function sendChat() {
    if (!chatPrompt.trim() || !activeFile || !projectId) return
    setChatSending(true)
    setChatError(null)
    try {
      const res  = await fetch(`/api/files/${projectId}/${activeFile}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: chatPrompt.trim(), sessionId: sessionId ?? undefined }),
      })
      const data = await res.json() as { success: boolean; data?: { content: string }; error?: string }
      if (!data.success) throw new Error(data.error ?? 'Failed')
      setContent(data.data?.content ?? null)
      setChatPrompt('')
      void fetchFiles()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Failed to update file')
    } finally { setChatSending(false) }
  }

  function downloadFile() {
    if (!content || !activeFile) return
    const blob = new Blob([content], { type: 'text/plain' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = activeFile.split('/').pop() ?? 'file.txt'
    a.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
    setTimeout(() => setDownloaded(false), 2000)
  }

  const tree            = buildTree(files.map(f => f.path))
  const writtenFiles    = new Set(files.filter(f => f.inWorkspace).map(f => f.path))
  const activeBasename  = activeFile?.split('/').pop() ?? ''
  const activeDirPart   = activeFile ? activeFile.split('/').slice(0, -1).join('/') : ''
  const activeLineCount = content ? content.split('\n').length : 0
  const activeExt       = activeBasename.split('.').pop() ?? ''
  const canEdit         = !!sessionId   // editing requires a model config from the session

  return (
    <div className="flex h-full bg-zinc-950">

      {/* ── Left: file tree ────────────────────────────────────────────── */}
      <nav aria-label="Project files" className="w-52 shrink-0 border-r border-zinc-800 flex flex-col">

        <div className="border-b border-zinc-800 px-4 py-2.5 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-widest text-zinc-600">
              Files
              {files.length > 0 && (
                <span className="ml-1.5 text-zinc-700">({files.length})</span>
              )}
            </span>
            <button
              onClick={fetchFiles}
              aria-label="Refresh file list"
              className="font-mono text-[10px] text-zinc-700 hover:text-zinc-400 transition-colors"
            >
              ↻
            </button>
          </div>
          {workspaceDir && (
            <p
              className="font-mono text-[8px] text-emerald-800 truncate"
              title={workspaceDir}
            >
              ⇒ {workspaceDir}
            </p>
          )}
        </div>

        {files.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="files-empty-state">
            <span className="font-mono text-2xl text-zinc-800" aria-hidden>∅</span>
            <p className="font-mono text-[10px] text-zinc-700 leading-relaxed">
              No files yet.{' '}
              <br/>
              Run a pipeline and accept each generated file to see it here.
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto py-2">
            <TreeRows
              nodes={tree}
              depth={0}
              pathPrefix=""
              activeFile={activeFile}
              onSelect={selectFile}
              writtenFiles={writtenFiles}
            />
          </div>
        )}
      </nav>

      {/* ── Right: viewer + chat ───────────────────────────────────────── */}
      <main className="flex flex-1 flex-col min-w-0">
        {activeFile ? (
          <>
            {/* File header */}
            <div className="shrink-0 border-b border-zinc-800 px-6 py-4 space-y-1">
              <div className="flex items-end justify-between gap-4">
                <div className="font-mono leading-none min-w-0">
                  {activeDirPart && (
                    <span className="text-sm text-zinc-500">{activeDirPart}/</span>
                  )}
                  <span className="text-sm font-semibold text-indigo-300">{activeBasename}</span>
                  <span className="ml-2 text-[10px] text-zinc-700">{activeLineCount} lines</span>
                </div>
                <button
                  onClick={downloadFile}
                  disabled={!content}
                  aria-label={`Download ${activeBasename}`}
                  className={cn(
                    'shrink-0 rounded-sm border px-3 py-1 font-mono text-[10px] transition-colors disabled:opacity-30',
                    downloaded
                      ? 'border-green-800 text-green-400'
                      : 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300',
                  )}
                >
                  {downloaded ? '✓ saved' : '↓ download'}
                </button>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {activeExt && (
                  <span className={cn('inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider border-zinc-800', extColor(activeExt))}>
                    {activeExt}
                  </span>
                )}
                {workspacePath && (
                  <span
                    className="font-mono text-[9px] text-zinc-600 truncate max-w-xs"
                    title={workspacePath}
                  >
                    {workspacePath}
                  </span>
                )}
                {commitHash && (
                  <span className="font-mono text-[9px] text-emerald-700 shrink-0">
                    written ✓ {commitHash}
                  </span>
                )}
              </div>
            </div>

            {/* Code viewer */}
            <div className="flex flex-1 overflow-hidden" aria-label={`Contents of ${activeFile}`}>
              <div className="w-1 shrink-0 bg-indigo-600/70" aria-hidden />
              {loading ? (
                <div className="flex flex-1 items-center justify-center">
                  <span className="font-mono text-xs text-zinc-700 animate-pulse">loading…</span>
                </div>
              ) : (
                <pre className="flex-1 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed text-zinc-200 bg-zinc-950 selection:bg-indigo-900/40">
                  {content ?? ''}
                </pre>
              )}
            </div>

            {/* Chat panel */}
            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/40 px-6 py-4 space-y-3">
              {chatError && (
                <p role="alert" className="font-mono text-xs text-red-400">{chatError}</p>
              )}

              {chatSending ? (
                <div className="flex items-center gap-2 py-2">
                  <span className="font-mono text-xs text-indigo-400 animate-pulse">Updating file…</span>
                  <span className="font-mono text-[10px] text-zinc-600">{activeBasename}</span>
                </div>
              ) : (
                <div>
                  <label id={chatLabelId} className="sr-only">
                    Describe changes to make to {activeFile}
                  </label>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 font-mono text-xs text-zinc-600 mt-2 select-none" aria-hidden>$</span>
                    <textarea
                      value={chatPrompt}
                      onChange={e => setChatPrompt(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && chatPrompt.trim()) {
                          e.preventDefault()
                          void sendChat()
                        }
                      }}
                      placeholder={`Describe changes to ${activeBasename}…  (Ctrl/⌘↵ to send)`}
                      disabled={!canEdit}
                      rows={2}
                      aria-labelledby={chatLabelId}
                      aria-disabled={!canEdit}
                      className="flex-1 resize-none rounded-sm border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-zinc-600 focus:outline-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                    <button
                      onClick={sendChat}
                      disabled={!chatPrompt.trim() || !canEdit}
                      aria-label={`Send changes to ${activeBasename}`}
                      className={cn(
                        'shrink-0 self-end rounded-sm border px-3 py-2 font-mono text-xs transition-colors',
                        chatPrompt.trim() && canEdit
                          ? 'border-zinc-600 text-zinc-300 hover:border-zinc-400 hover:text-zinc-100'
                          : 'border-zinc-800 text-zinc-700 cursor-not-allowed',
                      )}
                    >
                      ↵
                    </button>
                  </div>
                  {!canEdit && (
                    <p className="mt-2 font-mono text-[10px] text-zinc-700">
                      Open a project and run a pipeline to enable file editing.
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center" aria-label="No file selected">
            <span className="font-mono text-4xl text-zinc-800" aria-hidden>{ }</span>
            <div className="space-y-1">
              <p className="font-mono text-xs text-zinc-600">Select a file to view its code</p>
              {files.length > 0 && (
                <p className="font-mono text-[10px] text-zinc-700">
                  {files.length} file{files.length !== 1 ? 's' : ''} in this project
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
