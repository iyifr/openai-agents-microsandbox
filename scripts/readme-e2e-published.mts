/**
 * Verify install paths from README: PyPI wheel + npm pack of packages/openai-agents
 * (registry npm@0.2.0 still exports sandboxRun; README uses sandboxConfig from the next TS release).
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd: string, args: string[], cwd?: string) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\n${result.stderr || result.stdout}`)
  }
  return (result.stdout || '').trim()
}

async function checkNpmPackMatchesReadme() {
  const registryVersion = run('npm', ['view', 'openai-agents-msb', 'version'])
  console.log(`  npm registry: openai-agents-msb@${registryVersion} (README targets sandboxConfig from the workspace pack)`)

  const packDir = await mkdtemp(join(tmpdir(), 'mst-readme-pack-'))
  const installDir = await mkdtemp(join(tmpdir(), 'mst-readme-npm-'))
  try {
    run('npm', ['pack', '--pack-destination', packDir], join(repoRoot, 'packages/openai-agents'))
    const tarball = (await readdir(packDir)).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error('npm pack produced no tarball')

    run('npm', ['init', '-y'], installDir)
    run('npm', ['install', join(packDir, tarball), '@openai/agents', 'microsandbox@^0.7.7', 'zod'], installDir)
    run('node', [
      '-e',
      "import('openai-agents-msb').then(m => { if (!m.run || !m.sandboxConfig) throw new Error('missing README exports'); console.log('npm pack import ok') })",
    ], installDir)
    run('node', [
      '-e',
      "import('openai-agents-msb/core').then(m => { if (!m.WorkspaceContext) throw new Error('missing core export'); console.log('npm core import ok') })",
    ], installDir)
  } finally {
    await rm(packDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
  }
}

async function checkPyPiMatchesReadme() {
  const meta = JSON.parse(run('curl', ['-fsSL', 'https://pypi.org/pypi/openai-agents-msb/json']))
  const latest = meta.info.version as string
  console.log(`  pypi: openai-agents-msb@${latest}`)

  const dir = await mkdtemp(join(tmpdir(), 'mst-readme-pypi-'))
  try {
    run('uv', ['venv', join(dir, '.venv')], dir)
    const py = join(dir, '.venv', 'bin', 'python')
    run('uv', ['pip', 'install', '--python', py, `openai-agents-msb==${latest}`, 'openai-agents'], dir)
    run(py, [
      '-c',
      'from openai_agents_msb import run, sandbox_config, WorkspaceContext, InputFile; print("pypi import ok")',
    ], dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  await checkNpmPackMatchesReadme()
  await checkPyPiMatchesReadme()
  console.log('  ok: published-style installs match README imports')
}

main().catch((err) => {
  console.error('  FAIL:', err)
  process.exit(1)
})
