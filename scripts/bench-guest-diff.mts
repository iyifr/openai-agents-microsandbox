/**
 * Benchmark legacy full-read snapshot vs production guest-workspace (SoA + merge).
 *
 *   pnpm --filter openai-agents-msb run build
 *   node scripts/bench-guest-diff.mts
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Sandbox, isRuntimeInstalled } from 'microsandbox'
import {
  emitGuestFileOutputs,
  snapshotGuestWorkspace,
} from '../packages/openai-agents/dist/guest-workspace.js'

const GUEST_WORKSPACE = '/workspace'

const microsandboxSupported =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) ||
  process.platform === 'win32'

type FsOps = ReturnType<Sandbox['fs']>

function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function walkGuestList(root: string, fsOps: FsOps) {
  const files: { rel: string; guestPath: string }[] = []

  async function visit(dir: string) {
    let entries
    try {
      entries = await fsOps.list(dir)
    } catch {
      return
    }
    const prefix = root.endsWith('/') ? root : `${root}/`
    for (const entry of entries) {
      const guestPath = entry.path.startsWith('/') ? entry.path : `${dir}/${entry.path}`
      const rel =
        guestPath === root
          ? ''
          : guestPath.startsWith(prefix)
            ? guestPath.slice(prefix.length)
            : guestPath
      if (entry.kind === 'directory') await visit(guestPath)
      else if (entry.kind === 'file') files.push({ rel, guestPath })
    }
  }

  await visit(root)
  return files
}

/** Legacy: read + hash every file when building the baseline. */
async function snapshotLegacyFullRead(sb: Sandbox) {
  const fsOps = sb.fs()
  const listed = await walkGuestList(GUEST_WORKSPACE, fsOps)
  for (const f of listed) {
    hashBytes(await fsOps.read(f.guestPath))
  }
}

async function seedWorkspace(sb: Sandbox, count: number, bytesEach: number) {
  const fsOps = sb.fs()
  await fsOps.mkdir(GUEST_WORKSPACE).catch(() => {})
  for (let i = 0; i < count; i++) {
    const body = Buffer.alloc(bytesEach, i % 256)
    await fsOps.write(`${GUEST_WORKSPACE}/file-${String(i).padStart(4, '0')}.bin`, body)
  }
}

async function mutateWorkspace(sb: Sandbox, changed: number, count: number, bytesEach: number) {
  const fsOps = sb.fs()
  for (let k = 0; k < changed; k++) {
    const i = Math.floor((k * count) / changed)
    const body = Buffer.alloc(bytesEach, (i + 99) % 256)
    await fsOps.write(`${GUEST_WORKSPACE}/file-${String(i).padStart(4, '0')}.bin`, body)
  }
  await fsOps.write(`${GUEST_WORKSPACE}/output-new.txt`, 'new file')
}

async function runCase(label: string, fileCount: number, bytesEach: number, changed: number) {
  const name = `mst-bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-bench-ws-'))
  const hostBind = await fs.realpath(hostDir)
  const sb = await Sandbox.builder(name)
    .image('python:3.12-slim')
    .memory(512)
    .replace()
    .volume(GUEST_WORKSPACE, (m) => m.bind(hostBind))
    .create()

  try {
    await seedWorkspace(sb, fileCount, bytesEach)

    const tSnap0 = performance.now()
    await snapshotLegacyFullRead(sb)
    const legacySnapMs = performance.now() - tSnap0

    const tSnap1 = performance.now()
    const snap = await snapshotGuestWorkspace(sb)
    const prodSnapMs = performance.now() - tSnap1

    await mutateWorkspace(sb, changed, fileCount, bytesEach)

    let prodEmitted = 0
    const tEmit1 = performance.now()
    await emitGuestFileOutputs(sb, {
      onFileOutput: async () => {
        prodEmitted++
      },
    }, snap)
    const prodEmitMs = performance.now() - tEmit1

    console.log(`\n${label}`)
    console.log(`  files=${fileCount}  size=${bytesEach}B  changed≈${changed}  (+1 new)`)
    console.log(
      `  LEGACY snap (read all)  ${legacySnapMs.toFixed(1)}ms`,
    )
    console.log(
      `  PRODUCTION snap+emit     snap=${prodSnapMs.toFixed(1)}ms  emit=${prodEmitMs.toFixed(1)}ms  total=${(prodSnapMs + prodEmitMs).toFixed(1)}ms  emitted=${prodEmitted}`,
    )
    console.log(`  snap speedup ${(legacySnapMs / prodSnapMs).toFixed(2)}x`)
  } finally {
    await sb.stop().catch(() => {})
    await Sandbox.remove(name).catch(() => {})
    await fs.rm(hostDir, { recursive: true, force: true })
  }
}

async function main() {
  if (!microsandboxSupported || !isRuntimeInstalled()) {
    console.log('skip: microsandbox not available')
    process.exit(0)
  }

  console.log('Guest workspace diff benchmark\n')

  await runCase('small', 20, 4 * 1024, 2)
  await runCase('medium', 200, 32 * 1024, 10)
  await runCase('large inputs', 80, 512 * 1024, 5)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
