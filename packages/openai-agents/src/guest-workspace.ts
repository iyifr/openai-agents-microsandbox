import { createHash } from 'node:crypto'
import type { Sandbox } from 'microsandbox'
import type { FileChangeKind, WorkspaceContextOptions } from './core/types.js'
import { GUEST_WORKSPACE } from './host-workspace.js'

const MAX_BUFFER_BYTES = 2 ** 31 - 1

/** Sorted struct-of-arrays workspace fingerprint (stat-only at snapshot time). */
export type GuestWorkspaceSnapshot = {
  paths: string[]
  guestPaths: string[]
  size: Uint32Array
  mtimeMs: Float64Array
  /** SHA-256 hex when known without scanning the tree (e.g. after inputFiles seed). */
  contentHash: (string | undefined)[]
}

type ListedFile = { rel: string; guestPath: string; size: number; mtimeMs: number }

function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function pathIndex(paths: string[], rel: string): number {
  let lo = 0
  let hi = paths.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = paths[mid]!
    if (v === rel) return mid
    if (v < rel) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

async function walkGuestFiles(root: string, fs: ReturnType<Sandbox['fs']>): Promise<ListedFile[]> {
  const files: ListedFile[] = []
  const prefix = root.endsWith('/') ? root : `${root}/`

  async function visit(dir: string) {
    let entries
    try {
      entries = await fs.list(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const guestPath = entry.path.startsWith('/') ? entry.path : `${dir}/${entry.path}`
      const rel =
        guestPath === root
          ? ''
          : guestPath.startsWith(prefix)
            ? guestPath.slice(prefix.length)
            : guestPath

      if (entry.kind === 'directory') await visit(guestPath)
      else if (entry.kind === 'file') {
        files.push({
          rel,
          guestPath,
          size: entry.size,
          mtimeMs: entry.modified?.getTime() ?? 0,
        })
      }
    }
  }

  await visit(root)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return files
}

function listedToSnapshot(listed: ListedFile[]): GuestWorkspaceSnapshot {
  const n = listed.length
  const paths = new Array<string>(n)
  const guestPaths = new Array<string>(n)
  const size = new Uint32Array(n)
  const mtimeMs = new Float64Array(n)
  const contentHash: (string | undefined)[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const f = listed[i]!
    paths[i] = f.rel
    guestPaths[i] = f.guestPath
    size[i] = f.size
    mtimeMs[i] = f.mtimeMs
    contentHash[i] = undefined
  }
  return { paths, guestPaths, size, mtimeMs, contentHash }
}

export async function snapshotGuestWorkspace(sb: Sandbox): Promise<GuestWorkspaceSnapshot> {
  return listedToSnapshot(await walkGuestFiles(GUEST_WORKSPACE, sb.fs()))
}

/** Record content hashes for paths just written (inputFiles seed). */
export function applySeedContentHashes(
  snap: GuestWorkspaceSnapshot,
  seeds: { name: string; data: Uint8Array }[],
) {
  for (const { name, data } of seeds) {
    const i = pathIndex(snap.paths, name)
    if (i < 0) continue
    snap.contentHash[i] = hashBytes(data)
    snap.size[i] = data.byteLength
  }
}

type DiffHit = { beforeIndex: number; listed: ListedFile; reason: 'new' | 'changed' }

function mergeDiff(before: GuestWorkspaceSnapshot, listed: ListedFile[]): DiffHit[] {
  const out: DiffHit[] = []
  let i = 0
  let j = 0
  while (i < before.paths.length && j < listed.length) {
    const a = before.paths[i]!
    const b = listed[j]!.rel
    if (a === b) {
      const size = listed[j]!.size
      const mtime = listed[j]!.mtimeMs
      if (size !== before.size[i]! || mtime !== before.mtimeMs[i]!) {
        out.push({ beforeIndex: i, listed: listed[j]!, reason: 'changed' })
      }
      i++
      j++
    } else if (a < b) {
      i++
    } else {
      out.push({ beforeIndex: -1, listed: listed[j]!, reason: 'new' })
      j++
    }
  }
  while (j < listed.length) {
    out.push({ beforeIndex: -1, listed: listed[j]!, reason: 'new' })
    j++
  }
  return out
}

export async function emitGuestFileOutputs(
  sb: Sandbox,
  ws: WorkspaceContextOptions | undefined,
  before: GuestWorkspaceSnapshot,
) {
  const fs = sb.fs()
  const listed = await walkGuestFiles(GUEST_WORKSPACE, fs)

  try {
    await ws?.onWorkspaceSnapshot?.(
      listed.map((f) => `${GUEST_WORKSPACE}/${f.rel}`),
    )
  } finally {
    if (!ws?.onFileOutput) return

    for (const hit of mergeDiff(before, listed)) {
      const { rel, guestPath, size, mtimeMs } = hit.listed
      const data = await fs.read(guestPath)

      if (hit.reason === 'changed') {
        const i = hit.beforeIndex
        const sizeUnchanged = size === before.size[i]!
        const mtimeChanged = mtimeMs !== before.mtimeMs[i]!
        if (sizeUnchanged && mtimeChanged) {
          const baselineHash = before.contentHash[i]
          if (baselineHash && hashBytes(data) === baselineHash) continue
        }
      }

      const change: FileChangeKind = hit.reason === 'new' ? 'created' : 'modified'
      await ws.onFileOutput({
        file_name: rel,
        change,
        version: 1,
        size,
        path: guestPath,
        buffer: size <= MAX_BUFFER_BYTES ? data : undefined,
      })
    }
  }
}
