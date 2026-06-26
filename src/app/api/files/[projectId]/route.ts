import { NextResponse, type NextRequest } from 'next/server'
import fs   from 'fs'
import path from 'path'
import { listOutputFiles, writeOutput } from '@/lib/memory/filesystem'
import type { ApiResponse } from '@/types'

const getDataDir = () => process.env.DATA_DIR ?? './data'

interface FileEntry {
  path: string
  size: number
  updatedAt: number
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
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<NextResponse<ApiResponse<{ files: FileEntry[] }>>> {
  try {
    const { projectId } = await params
    if (!projectId) return NextResponse.json({ success: false, error: 'Missing projectId' }, { status: 400 })

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
      return { path: name, size, updatedAt }
    })

    return NextResponse.json({ success: true, data: { files } })
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 })
  }
}
