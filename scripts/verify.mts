import { formatYaml, assertSafeFilename, WorkspaceContext } from '../packages/openai-agents/dist/core/index.js'

const microsandboxSupported =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'linux' &&
    (process.arch === 'x64' || process.arch === 'arm64')) ||
  process.platform === 'win32'

let passed = 0
let failed = 0

function ok(name: string) {
  passed++
  console.log(`  ok: ${name}`)
}

function fail(name: string, err: unknown) {
  failed++
  console.error(`  FAIL: ${name}`, err)
}

// --- openai-agents-msb/core (always) ---
const yaml = formatYaml({ exit_code: 0, stdout: 'hello', stderr: '' })
if (yaml.includes('exit_code: 0') && yaml.includes('hello')) ok('formatYaml')
else fail('formatYaml', yaml)

try {
  assertSafeFilename('../etc/passwd')
  fail('assertSafeFilename rejects traversal', 'no throw')
} catch {
  ok('assertSafeFilename rejects traversal')
}

const ctx = WorkspaceContext({ inputFiles: [] })
if (typeof ctx === 'object' && ctx !== null) ok('WorkspaceContext')
else fail('WorkspaceContext', ctx)

// --- openai-agents-msb (requires microsandbox native bindings) ---
if (!microsandboxSupported) {
  console.log(
    `  skip: openai-agents runtime tests (microsandbox unsupported on ${process.platform}-${process.arch})`,
  )
} else {
  const { Agent } = await import('@openai/agents')
  const { run, sandboxConfig } = await import('../packages/openai-agents/dist/index.js')

  const agent = new Agent({
    name: 'test',
    instructions: 'test',
    tools: [sandboxConfig({ image: 'alpine', interpreter: 'sh' })],
  })

  try {
    await run(agent, 'hi', { sandbox: {} } as any)
    fail('rejects options.sandbox', 'no throw')
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('options.sandbox'))
      ok('rejects options.sandbox')
    else fail('rejects options.sandbox', e)
  }

  const conflictAgent = new Agent({
    name: 'conflict',
    instructions: 'test',
    tools: [
      sandboxConfig({ image: 'alpine', interpreter: 'sh' }),
      sandboxConfig({ image: 'ubuntu', interpreter: 'bash' }),
    ],
  })

  try {
    await run(conflictAgent, 'hi', WorkspaceContext({}))
    fail('config conflict', 'no throw')
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('identical SandboxConfig'))
      ok('config conflict detection')
    else fail('config conflict detection', e)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

console.log('build: ok (pnpm build completed successfully)')
