import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertSafeFilename, normalizeFile } from './core/index.js'
import type { WorkspaceContextOptions, WorkspaceInput } from './core/index.js'

/**
 * /workspace is a host directory bind-mounted into the VM, so outputs are read
 * from the host and survive the VM dying. Callers must stop the VM before
 * reading outputs, so the guest can't swap files for symlinks mid-read.
 */
export const GUEST_WORKSPACE = '/workspace'

type FileFingerprint = { size: number; mtimeMs: number; hash: string }

/** Fingerprints keyed by path relative to the workspace root. */
export type WorkspaceSnapshot = Map<string, FileFingerprint>

// fs.readFile() refuses files of 2 GiB or more.
const MAX_BUFFER_BYTES = 2 ** 31 - 1

function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Streams the file so hashing never loads it into memory. */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), '.mst', 'workspaces')

/** Directory holding one folder per persistent session. */
export function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return path.resolve(workspaceRoot ?? DEFAULT_WORKSPACE_ROOT)
}

export function sessionDir(name: string, workspaceRoot?: string): string {
  return path.join(resolveWorkspaceRoot(workspaceRoot), name)
}

/**
 * Persistent sessions keep a stable directory per sandbox name; everything else
 * gets a temp directory (under `<workspaceRoot>/.tmp` when a root is given).
 * Real paths only: microsandbox can't bind a path that runs through a symlink
 * (macOS /var -> /private/var).
 */
export async function createWorkspaceDir(
  name: string,
  persistent: boolean,
  workspaceRoot?: string,
): Promise<string> {
  if (!persistent) {
    const parent = workspaceRoot
      ? path.join(resolveWorkspaceRoot(workspaceRoot), '.tmp')
      : os.tmpdir()
    await fs.mkdir(parent, { recursive: true })
    return fs.realpath(await fs.mkdtemp(path.join(parent, 'mst-ws-')))
  }
  const dir = sessionDir(name, workspaceRoot)
  await fs.mkdir(dir, { recursive: true })
  return fs.realpath(dir)
}

export async function clearWorkspaceDir(dir: string) {
  for (const entry of await fs.readdir(dir)) {
    await fs.rm(path.join(dir, entry), { recursive: true, force: true })
  }
}

export function assertInputNames(inputs: WorkspaceInput[]) {
  const seen = new Set<string>()
  for (const f of inputs) {
    assertSafeFilename(f.name)
    if (seen.has(f.name)) {
      throw new Error(`[mst] Duplicate input file name: ${JSON.stringify(f.name)}`)
    }
    seen.add(f.name)
  }
}

export async function seedInputFiles(
  dir: string,
  inputs: WorkspaceInput[],
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map()
  for (const f of inputs) {
    const data = f instanceof File ? new Uint8Array(await f.arrayBuffer()) : normalizeFile(f).data
    const filePath = path.join(dir, f.name)
    await fs.writeFile(filePath, data)
    const { mtimeMs } = await fs.stat(filePath)
    snapshot.set(f.name, { size: data.byteLength, mtimeMs, hash: hashBytes(data) })
  }
  return snapshot
}

type Entries = { files: string[]; all: string[] }

/** Lists entries without following symlinks; only regular files count as outputs. */
async function walk(dir: string, rel = '', acc: Entries = { files: [], all: [] }): Promise<Entries> {
  for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    acc.all.push(relPath)
    if (entry.isDirectory()) await walk(dir, relPath, acc)
    else if (entry.isFile()) acc.files.push(relPath)
  }
  return acc
}

export async function snapshotWorkspace(dir: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map()
  for (const rel of (await walk(dir)).files) {
    const filePath = path.join(dir, rel)
    const { size, mtimeMs } = await fs.stat(filePath)
    snapshot.set(rel, { size, mtimeMs, hash: await hashFile(filePath) })
  }
  return snapshot
}

export async function emitFileOutputs(
  dir: string,
  ws: WorkspaceContextOptions | undefined,
  inputSnapshot: WorkspaceSnapshot,
) {
  const { files, all } = await walk(dir)

  // A failing snapshot callback (UI) must not drop the file outputs.
  try {
    await ws?.onWorkspaceSnapshot?.(all.map((rel) => `${GUEST_WORKSPACE}/${rel}`).sort())
  } finally {
    if (ws?.onFileOutput) {
      for (const rel of files) {
        const filePath = path.join(dir, rel)
        const original = inputSnapshot.get(rel)
        const { size, mtimeMs } = await fs.stat(filePath)

        if (original) {
          // Fast path: skip files whose size and mtime haven't changed
          if (size === original.size && mtimeMs === original.mtimeMs) continue
          // Slow path: hash to confirm the change
          if (size === original.size && (await hashFile(filePath)) === original.hash) continue
        }

        await ws.onFileOutput({
          file_name: rel,
          change: original ? 'modified' : 'created',
          version: 1,
          size,
          path: filePath,
          buffer: size <= MAX_BUFFER_BYTES ? await fs.readFile(filePath) : undefined,
        })
      }
    }
  }
}
