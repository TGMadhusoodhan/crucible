// Browser-only — File System Access API + IndexedDB for folder handle persistence.
// Works on Vercel: everything is client-side, no server filesystem access required.
// FileSystemDirectoryHandle is structured-cloneable so IDB can store/retrieve it.

import type { ConsensusOutput, SpecDocument } from '@/types'

// ─── File System Access API type declarations ─────────────────────────────────
// These are defined in the WICG spec but not yet in TypeScript's lib.dom.d.ts.

type FileSystemPermissionMode = 'read' | 'readwrite'

interface FileSystemHandlePermissionDescriptor {
  mode: FileSystemPermissionMode
}

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
    requestPermission(descriptor: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  }
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

const DB_NAME = 'crucible'
const STORE   = 'localFolders'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror   = () => reject(req.error)
  })
}

async function idbDel(key: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

// ─── Permission helper ────────────────────────────────────────────────────────

async function verifyReadWrite(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as FileSystemPermissionMode }
  if (await handle.queryPermission(opts) === 'granted') return true
  return (await handle.requestPermission(opts)) === 'granted'
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the current browser supports the File System Access API.
 * Chrome/Edge: yes. Firefox/Safari: no.
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * Opens a directory picker and stores the handle in IndexedDB.
 * Returns null if the user dismissed the picker or the browser doesn't support the API.
 */
export async function pickProjectFolder(
  projectId: string,
): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported()) return null
  try {
    const handle = await (window as typeof window & { showDirectoryPicker(o?: { mode?: FileSystemPermissionMode }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' })
    await idbPut(`projectFolder:${projectId}`, handle)
    return handle
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

/**
 * Returns the stored folder handle for a project, or null if none is linked.
 */
export async function getProjectFolder(
  projectId: string,
): Promise<FileSystemDirectoryHandle | null> {
  return idbGet<FileSystemDirectoryHandle>(`projectFolder:${projectId}`)
}

/**
 * Removes the stored folder handle for a project.
 */
export async function unlinkProjectFolder(projectId: string): Promise<void> {
  await idbDel(`projectFolder:${projectId}`)
}

/**
 * Returns true if a folder handle exists in IDB for this project.
 * Does NOT verify the handle is still accessible (no permission prompt).
 */
export async function hasFolderLinked(projectId: string): Promise<boolean> {
  return (await getProjectFolder(projectId)) !== null
}

// ─── Output metadata ──────────────────────────────────────────────────────────

export interface LocalOutput {
  output:    ConsensusOutput
  spec:      SpecDocument | null
  savedAt:   number
  projectId: string
}

/**
 * Saves consensus output to the linked local folder.
 *
 *   output.txt          — raw code (open in any editor)
 *   crucible-meta.json  — full metadata for session state restoration
 *
 * Returns the folder name on success, or null if no folder is linked or
 * permission was denied.
 */
export async function saveOutputToFolder(
  projectId: string,
  output:    ConsensusOutput,
  spec:      SpecDocument | null,
): Promise<string | null> {
  const handle = await getProjectFolder(projectId)
  if (!handle) return null

  const granted = await verifyReadWrite(handle)
  if (!granted) return null

  // Write raw code
  const codeFH = await handle.getFileHandle('output.txt', { create: true })
  const codeW  = await codeFH.createWritable()
  await codeW.write(output.code)
  await codeW.close()

  // Write metadata for restoration
  const meta: LocalOutput = { output, spec, savedAt: Date.now(), projectId }
  const metaFH = await handle.getFileHandle('crucible-meta.json', { create: true })
  const metaW  = await metaFH.createWritable()
  await metaW.write(JSON.stringify(meta, null, 2))
  await metaW.close()

  return handle.name
}

/**
 * Reads previously saved output from the linked local folder.
 * Returns null if no folder is linked, permission denied, or no meta file exists.
 */
export async function readOutputFromFolder(
  projectId: string,
): Promise<LocalOutput | null> {
  const handle = await getProjectFolder(projectId)
  if (!handle) return null

  const granted = await verifyReadWrite(handle)
  if (!granted) return null

  try {
    const metaFH = await handle.getFileHandle('crucible-meta.json')
    const file   = await metaFH.getFile()
    return JSON.parse(await file.text()) as LocalOutput
  } catch {
    return null
  }
}
