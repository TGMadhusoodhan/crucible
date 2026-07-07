import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import fs   from 'fs'
import path from 'path'
import { db, schema } from '@/lib/db'
import { listOutputFiles, writeOutput } from '@/lib/memory/filesystem'
import { resolveInWorkspace } from '@/lib/workspace/paths'
import { buildZip } from '@/lib/zip'
import type { ApiResponse } from '@/types'

const getDataDir = () => process.env.DATA_DIR ?? './data'

interface FileEntry {
  path:        string
  size:        number
  updatedAt:   number
  inWorkspace: boolean
}

// When the output/ directory is empty but output.json exists (e.g. pipeline
// reached consensus but user never completed the file gate), hydrate the
// output/ directory from the stored ConsensusOutput so Files section works.
function hydrateOutputDirIfNeeded(projectId: string): void {
  const dataDir    = getDataDir()
  const outJsonPath = path.join(dataDir, 'projects', projectId, 'output.json')
  if (!fs.existsSync(outJsonPath)) return

  try {
    const stored = JSON.parse(fs.readFileSync(outJsonPath, 'utf8')) as {
      output?: { files?: Record<string, string> }
    }
    const files = stored.output?.files
    if (!files || Object.keys(files).length === 0) return

    // Write each file only if it doesn't already exist in output/
    for (const [filename, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue
      const dest = path.join(dataDir, 'projects', projectId, 'output', filename)
      if (!fs.existsSync(dest)) {
        writeOutput(projectId, filename, content)
      }
    }
  } catch { /* best-effort */ }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response | NextResponse<ApiResponse<{ files: FileEntry[]; workspaceDir: string | null }>>> {
  try {
    const { projectId } = await params
    if (!projectId) return NextResponse.json({ success: false, error: 'Missing projectId' }, { status: 400 })

    // ?download=1 → single file download or ZIP of all files
    if (new URL(request.url).searchParams.has('download')) {
      hydrateOutputDirIfNeeded(projectId)
      const filenames = listOutputFiles(projectId)
      if (filenames.length === 0) {
        return NextResponse.json({ success: false, error: 'No files found' }, { status: 404 })
      }
      const outDir = path.join(getDataDir(), 'projects', projectId, 'output')

      if (filenames.length === 1) {
        const filename = filenames[0]!
        let content: Buffer
        try { content = fs.readFileSync(path.join(outDir, filename)) }
        catch { return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 }) }
        return new Response(new Uint8Array(content), {
          headers: {
            'Content-Type':        'application/octet-stream',
            'Content-Disposition': `attachment; filename="${path.basename(filename)}"`,
            'Content-Length':      String(content.length),
          },
        })
      }

      const entries: { name: string; data: Buffer }[] = []
      for (const filename of filenames) {
        try { entries.push({ name: filename, data: fs.readFileSync(path.join(outDir, filename)) }) }
        catch { /* skip unreadable */ }
      }
      if (entries.length === 0) {
        return NextResponse.json({ success: false, error: 'No readable files' }, { status: 404 })
      }
      const zipBuf = buildZip(entries)
      return new Response(new Uint8Array(zipBuf), {
        headers: {
          'Content-Type':        'application/zip',
          'Content-Disposition': 'attachment; filename="crucible-output.zip"',
          'Content-Length':      String(zipBuf.length),
        },
      })
    }

    // Load workspace dir for this project
    const [projectRow] = await db
      .select({ workspaceDir: schema.projects.workspaceDir })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1)
    const workspaceDir = projectRow?.workspaceDir ?? null

    // Ensure files are on disk (hydrate from output.json if gate was never completed)
    hydrateOutputDirIfNeeded(projectId)

    const filenames = listOutputFiles(projectId)
    const outDir    = path.join(getDataDir(), 'projects', projectId, 'output')

    const files: FileEntry[] = filenames.map(name => {
      const full = path.join(outDir, name)
      let size = 0, updatedAt = 0
      try {
        const stat = fs.statSync(full)
        size      = stat.size
        updatedAt = stat.mtimeMs
      } catch { /* file may not exist */ }

      let inWorkspace = false
      if (workspaceDir) {
        try {
          const wsPath = resolveInWorkspace(workspaceDir, name)
          inWorkspace  = fs.existsSync(wsPath)
        } catch { /* path traversal — treat as not in workspace */ }
      }

      return { path: name, size, updatedAt, inWorkspace }
    })

    return NextResponse.json({ success: true, data: { files, workspaceDir } })
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
