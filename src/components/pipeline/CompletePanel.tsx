'use client'

import { useEffect, useRef, useState } from 'react'
import { usePipelineState } from '@/store'
import { saveOutputToFolder, pickProjectFolder, isFileSystemAccessSupported } from '@/lib/localfs'

export function CompletePanel() {
  const { output, lastReview, round, spec, project } = usePipelineState()
  const [copied,     setCopied]     = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'no-folder'>('idle')
  const [folderName, setFolderName] = useState<string | null>(null)
  const savedRef = useRef(false)   // prevent double-save in StrictMode

  // Auto-save to linked folder as soon as consensus output is available.
  useEffect(() => {
    if (!output || !project?.id || savedRef.current) return
    savedRef.current = true
    setSaveStatus('saving')

    saveOutputToFolder(project.id, output, spec ?? null)
      .then((name) => {
        if (name) {
          setFolderName(name)
          setSaveStatus('saved')
        } else {
          setSaveStatus('no-folder')
        }
      })
      .catch(() => setSaveStatus('error'))
  }, [output, project?.id, spec])

  async function handlePickAndSave() {
    if (!output || !project?.id) return
    setSaveStatus('saving')
    try {
      const handle = await pickProjectFolder(project.id)
      if (!handle) { setSaveStatus('no-folder'); return }
      const name = await saveOutputToFolder(project.id, output, spec ?? null)
      if (name) { setFolderName(name); setSaveStatus('saved') }
      else setSaveStatus('error')
    } catch {
      setSaveStatus('error')
    }
  }

  if (!output) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-zinc-600">No output yet.</p>
      </div>
    )
  }

  async function copyCode() {
    await navigator.clipboard.writeText(output!.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-green-400">✓</span>
            <h2 className="text-sm font-medium text-zinc-200">Consensus Reached</h2>
          </div>
          <p className="text-xs text-zinc-600">
            Validated in {round} round{round !== 1 ? 's' : ''} · {output.code.length.toLocaleString()} chars
          </p>
        </div>

        <button
          onClick={copyCode}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
        >
          {copied ? '✓ Copied' : 'Copy Code'}
        </button>
      </div>

      {/* Local folder save status */}
      <div className="border-b border-zinc-800 px-6 py-2 flex items-center justify-between gap-4">
        {saveStatus === 'saving' && (
          <p className="text-xs text-zinc-500">Saving to local folder…</p>
        )}
        {saveStatus === 'saved' && (
          <p className="text-xs text-emerald-500">
            ✓ Saved to <span className="font-mono">{folderName}/output.txt</span>
          </p>
        )}
        {saveStatus === 'no-folder' && (
          <div className="flex items-center gap-3">
            <p className="text-xs text-zinc-500">No local folder linked — code not saved to disk yet.</p>
            {isFileSystemAccessSupported() ? (
              <button
                onClick={handlePickAndSave}
                className="shrink-0 rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
              >
                Pick folder &amp; save
              </button>
            ) : (
              <span className="text-[10px] text-zinc-600">Use Copy Code above — folder save requires Chrome/Edge</span>
            )}
          </div>
        )}
        {saveStatus === 'error' && (
          <div className="flex items-center gap-3">
            <p className="text-xs text-red-400">Save failed — check browser permissions.</p>
            <button
              onClick={handlePickAndSave}
              className="shrink-0 rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
        {saveStatus === 'idle' && (
          <p className="text-xs text-zinc-600">Preparing…</p>
        )}
      </div>

      {/* Low-severity notes */}
      {lastReview && lastReview.flags.filter(f => f.severity === 'LOW').length > 0 && (
        <div className="border-b border-zinc-800 px-6 py-2">
          <p className="text-[10px] text-zinc-600">
            Low-severity notes logged: {lastReview.flags.filter(f => f.severity === 'LOW').length} item(s) saved to review_list
          </p>
        </div>
      )}

      {/* Code output */}
      <div className="flex-1 overflow-y-auto">
        <pre className="min-h-full p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
          {output.code}
        </pre>
      </div>
    </div>
  )
}
