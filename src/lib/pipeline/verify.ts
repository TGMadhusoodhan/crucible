export interface VerifyResult {
  ok:     boolean
  errors: string[]
}

// TypeScript diagnostic codes to suppress — these fire because imports can't
// be resolved in our isolated in-memory compilation and are not real bugs.
const IGNORE_CODES = new Set([
  2307,  // Cannot find module '...' — expected; imports can't resolve without disk files
  2304,  // Cannot find name '...' — often from unresolved import types
  2792,  // Cannot find module (bundler resolution variant of 2307)
  2584,  // Cannot find name 'console' — missing lib types in isolated compilation
  2580,  // Cannot find name 'require' — missing lib types in isolated compilation
  // NOT suppressed: 1005 (',' expected) and 2440 (import conflicts local decl) are real bugs
])

export async function verifyFile(
  filename:      string,
  code:          string,
  acceptedFiles: Record<string, string>,
): Promise<VerifyResult> {
  const isTs = filename.endsWith('.ts') || filename.endsWith('.tsx')
  if (!isTs) return { ok: true, errors: [] }

  let ts: typeof import('typescript')
  try {
    // Dynamic import so the function degrades gracefully in production Docker
    // (typescript is a devDependency — not present in the standalone output).
    ts = (await import('typescript').then(m => m.default ?? m)) as typeof import('typescript')
  } catch {
    return { ok: true, errors: [] }
  }

  const compilerOptions: import('typescript').CompilerOptions = {
    noEmit:                    true,
    strict:                    true,
    target:                    ts.ScriptTarget.ESNext,
    module:                    ts.ModuleKind.ESNext,
    moduleResolution:          ts.ModuleResolutionKind.Bundler,
    noResolve:                 true,   // skip import resolution — files don't exist on disk
    skipLibCheck:              true,
    allowImportingTsExtensions: true,
    jsx:                       filename.endsWith('.tsx') ? ts.JsxEmit.ReactJSX : undefined,
  }

  // In-memory compiler host: serves the candidate file + already-accepted files,
  // returns empty string for everything else (unresolved imports).
  const allFiles: Record<string, string> = { ...acceptedFiles, [filename]: code }
  const host = ts.createCompilerHost(compilerOptions)
  const realReadFile = host.readFile.bind(host)

  host.readFile = (f: string) => {
    for (const [name, content] of Object.entries(allFiles)) {
      if (f === name || f.endsWith('/' + name) || f.endsWith('\\' + name)) return content
    }
    return realReadFile(f) ?? ''
  }
  host.fileExists = (f: string) => {
    for (const name of Object.keys(allFiles)) {
      if (f === name || f.endsWith('/' + name) || f.endsWith('\\' + name)) return true
    }
    return ts.sys.fileExists(f)
  }

  const program = ts.createProgram([filename], compilerOptions, host)
  const sourceFile = program.getSourceFile(filename)
  if (!sourceFile) return { ok: true, errors: [] }

  const syntactic = Array.from(program.getSyntacticDiagnostics(sourceFile))
  const semantic  = Array.from(program.getSemanticDiagnostics(sourceFile))
    .filter(d => !IGNORE_CODES.has(d.code))

  const all = [...syntactic, ...semantic]
  if (all.length === 0) return { ok: true, errors: [] }

  const errors = all.map(d => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    if (d.file && d.start != null) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start)
      return `Line ${pos.line + 1}:${pos.character + 1} — ${msg}`
    }
    return msg
  })

  return { ok: false, errors }
}
