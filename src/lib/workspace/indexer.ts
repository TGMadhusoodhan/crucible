import ts   from 'typescript'
import path  from 'path'
import fs    from 'fs'
import { resolveInWorkspace } from './paths'
import type { RegistryEntry } from '@/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

// ─── Modifier helpers (TypeScript 5.x API) ────────────────────────────────────

function getMods(node: ts.Node): readonly ts.Modifier[] {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? []
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return getMods(node).some(m => m.kind === kind)
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword)
}

function isDefault(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword)
}

function isAsync(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword)
}

function isPrivate(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.PrivateKeyword)
}

function isProtected(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
}

function isReadonly(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)
}

function isStatic(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword)
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatParams(params: ts.NodeArray<ts.ParameterDeclaration>, file: ts.SourceFile): string {
  return params.map(p => {
    const rest     = p.dotDotDotToken ? '...' : ''
    const name     = p.name.getText(file)
    const optional = p.questionToken ? '?' : ''
    const type     = p.type ? ': ' + p.type.getText(file) : ''
    return `${rest}${name}${optional}${type}`
  }).join(', ')
}

function formatTypeParams(typeParams: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, file: ts.SourceFile): string {
  if (!typeParams?.length) return ''
  return `<${typeParams.map(tp => tp.getText(file)).join(', ')}>`
}

// ─── Per-node extractors ──────────────────────────────────────────────────────

function extractFunctionSig(node: ts.FunctionDeclaration, file: ts.SourceFile): string {
  const name    = node.name?.getText(file)
  const def_    = isDefault(node) ? 'default ' : ''
  const async_  = isAsync(node)   ? 'async '   : ''
  const gen     = node.asteriskToken ? '*' : ''
  const tparams = formatTypeParams(node.typeParameters, file)
  const params  = formatParams(node.parameters, file)
  const ret     = node.type ? ': ' + node.type.getText(file) : ''
  return `export ${def_}${async_}function${gen} ${name ?? ''}${tparams}(${params})${ret}`
}

function extractClassSig(node: ts.ClassDeclaration, file: ts.SourceFile): string {
  const name    = node.name?.getText(file) ?? '(default)'
  const members: string[] = []

  for (const member of node.members) {
    if (isPrivate(member) || isProtected(member)) continue

    if (ts.isConstructorDeclaration(member)) {
      const params = formatParams(member.parameters, file)
      members.push(`constructor(${params})`)
    } else if (ts.isMethodDeclaration(member)) {
      const mname   = member.name.getText(file)
      const tparams = formatTypeParams(member.typeParameters, file)
      const params  = formatParams(member.parameters, file)
      const ret     = member.type ? ': ' + member.type.getText(file) : ''
      const async_  = isAsync(member) ? 'async ' : ''
      members.push(`${async_}${mname}${tparams}(${params})${ret}`)
    } else if (ts.isPropertyDeclaration(member)) {
      if (isReadonly(member) || isStatic(member)) {
        const pname  = member.name.getText(file)
        const type   = member.type ? ': ' + member.type.getText(file) : ''
        const prefix = isStatic(member) ? 'static ' : ''
        const ro     = isReadonly(member) ? 'readonly ' : ''
        members.push(`${prefix}${ro}${pname}${type}`)
      }
    } else if (ts.isGetAccessorDeclaration(member)) {
      const gname = member.name.getText(file)
      const ret   = member.type ? ': ' + member.type.getText(file) : ''
      members.push(`get ${gname}()${ret}`)
    }
  }

  const body = members.length > 0 ? ` { ${members.join('; ')} }` : ''
  return `export class ${name}${body}`
}

// ─── Public: build a compact signature block for one file ────────────────────

export function buildSignatureBlock(filename: string, code: string): string {
  const ext = path.extname(filename)
  if (!TS_EXTS.has(ext)) return `## ${filename}\n(non-TS file)`

  const kind = ext === '.tsx' || ext === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  let sourceFile: ts.SourceFile
  try {
    sourceFile = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, kind)
  } catch {
    return `## ${filename}\n(parse error)`
  }

  // Collect local relative imports (deduplicated, no node_modules)
  const imports: string[] = []
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text
      if (spec.startsWith('.') && !imports.includes(spec)) imports.push(spec)
    }
  }

  const lines: string[] = [`## ${filename}`]
  if (imports.length > 0) lines.push(`imports: ${imports.join(', ')}`)

  for (const stmt of sourceFile.statements) {
    // Named function declarations (including default)
    if (ts.isFunctionDeclaration(stmt) && isExported(stmt)) {
      lines.push(extractFunctionSig(stmt, sourceFile))
      continue
    }
    // Interfaces — emit full text (they ARE the contract)
    if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      lines.push(stmt.getText(sourceFile))
      continue
    }
    // Type aliases
    if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt)) {
      lines.push(stmt.getText(sourceFile))
      continue
    }
    // Classes
    if (ts.isClassDeclaration(stmt) && isExported(stmt)) {
      lines.push(extractClassSig(stmt, sourceFile))
      continue
    }
    // Enums — just list name + member names
    if (ts.isEnumDeclaration(stmt) && isExported(stmt)) {
      const name = stmt.name.getText(sourceFile)
      const members = stmt.members.map(m => m.name.getText(sourceFile)).join(', ')
      lines.push(`export enum ${name} { ${members} }`)
      continue
    }
    // Variable statements (export const foo: Bar = ...)
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(sourceFile)
        const type = decl.type ? ': ' + decl.type.getText(sourceFile) : ''
        // eslint-disable-next-line no-bitwise
        const kw   = (stmt.declarationList.flags & ts.NodeFlags.Const) ? 'const' : 'let'
        lines.push(`export ${kw} ${name}${type}`)
      }
      continue
    }
    // Named re-exports and wildcard re-exports
    if (ts.isExportDeclaration(stmt)) {
      const typeOnly = stmt.isTypeOnly ? 'type ' : ''
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        const names = stmt.exportClause.elements
          .map(e => {
            const orig  = e.propertyName?.getText(sourceFile)
            const alias = e.name.getText(sourceFile)
            return orig && orig !== alias ? `${orig} as ${alias}` : alias
          }).join(', ')
        const from = stmt.moduleSpecifier
          ? ` from '${(stmt.moduleSpecifier as ts.StringLiteral).text}'` : ''
        lines.push(`export ${typeOnly}{ ${names} }${from}`)
      } else if (!stmt.exportClause && stmt.moduleSpecifier) {
        lines.push(`export ${typeOnly}* from '${(stmt.moduleSpecifier as ts.StringLiteral).text}'`)
      }
      continue
    }
  }

  return lines.join('\n')
}

// ─── Public: backfill signature blocks for registry entries ──────────────────
// Incremental: skips files whose signatureBlock is already set and not drifted.

export function indexWorkspaceFiles(
  workspaceDir: string,
  registry:     RegistryEntry[],
  driftedFiles: string[],
): RegistryEntry[] {
  const driftSet = new Set(driftedFiles)
  return registry.map(entry => {
    if (entry.signatureBlock !== undefined && !driftSet.has(entry.filename)) return entry

    let fullPath: string
    try { fullPath = resolveInWorkspace(workspaceDir, entry.filename) } catch { return entry }
    let code: string
    try { code = fs.readFileSync(fullPath, 'utf8') } catch { return entry }

    return { ...entry, signatureBlock: buildSignatureBlock(entry.filename, code) }
  })
}
