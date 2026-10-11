/**
 * Runs README-shaped flows against a real microsandbox VM (no OpenAI API key).
 * Uses a scripted in-process model, same tool wiring as the docs.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@openai/agents'
import type { AgentOutputItem, Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents'
import { Sandbox, SandboxNotFoundError, isRuntimeInstalled } from 'microsandbox'
import {
  endSession,
  listSessions,
  run,
  sandboxConfig,
  sandboxExec,
  sandboxReadFile,
  sandboxWriteFile,
} from '../packages/openai-agents/dist/index.js'
const GUEST_WORKSPACE = '/workspace'
import { WorkspaceContext } from '../packages/openai-agents/dist/core/index.js'
import type { FileOutPayload } from '../packages/openai-agents/dist/core/index.js'

const microsandboxSupported =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'linux' &&
    (process.arch === 'x64' || process.arch === 'arm64')) ||
  process.platform === 'win32'

function usage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function assistant(text: string): AgentOutputItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  }
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  callId = `call-${crypto.randomUUID().slice(0, 8)}`,
): AgentOutputItem {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
  }
}

function scriptedModel(steps: AgentOutputItem[][]): Model {
  let turn = 0
  const next = () => {
    const output = steps[turn] ?? [assistant('done')]
    turn += 1
    return output
  }
  return {
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
      return { usage: usage(), output: next() }
    },
    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
      const output = next()
      const event: StreamEvent = {
        type: 'response_done',
        response: {
          id: `resp-${turn}`,
          usage: usage(),
          output,
        },
      }
      yield event
    },
  }
}

function reporterAgent(model: Model) {
  return new Agent({
    name: 'reporter',
    instructions: 'Write report.html. A table of the rows, then the totals.',
    tools: [
      sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3' }),
      sandboxExec(),
      sandboxReadFile(),
      sandboxWriteFile(),
    ],
    model,
  })
}

/** Tools only — VM attached via run({ sandboxHandle }). */
function handleAgent(model: Model) {
  return new Agent({
    name: 'reporter',
    instructions: 'Use the sandbox tools.',
    tools: [sandboxExec(), sandboxReadFile(), sandboxWriteFile()],
    model,
  })
}

async function createBoundSandbox(name: string, hostWorkspaceDir: string) {
  const hostDir = await fs.realpath(hostWorkspaceDir)
  return Sandbox.builder(name)
    .image('python:3.12-slim')
    .memory(512)
    .cpus(1)
    .replace()
    .volume(GUEST_WORKSPACE, (m) => m.bind(hostDir))
    .create()
}

function sessionAgent(model: Model) {
  return new Agent({
    name: 'reporter',
    instructions: 'Write report.html. A table of the rows, then the totals.',
    tools: [
      sandboxConfig({
        image: 'python:3.12-slim',
        interpreter: 'python3',
        persist: true,
      }),
      sandboxExec(),
      sandboxReadFile(),
      sandboxWriteFile(),
    ],
    model,
  })
}

async function cleanupSandboxes() {
  try {
    const page = await Sandbox.list()
    const leftovers = page.sandboxes.filter((s) => s.name.startsWith('mst-'))
    for (const { name } of leftovers) {
      try {
        await Sandbox.remove(name)
      } catch (err) {
        if (!(err instanceof SandboxNotFoundError)) throw err
      }
    }
  } catch (err) {
    console.warn('  warn: could not list sandboxes for cleanup (msb/microsandbox version mismatch?)', err)
  }
}

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

async function testGettingStarted(tmpDir: string) {
  const salesPath = path.join(tmpDir, 'sales.csv')
  await fs.writeFile(salesPath, 'sku,qty\nA,1\n')
  const html = '<table><tr><td>A</td><td>1</td></tr></table><p>total: 1</p>'
  const uploads: { bucket: string; key: string; body: Uint8Array }[] = []

  const agent = reporterAgent(
    scriptedModel([
      [callTool('sandbox_write_file', { path: '/workspace/report.html', content: html })],
      [assistant('March report is ready.')],
    ]),
  )

  await run(agent, 'March sales report', WorkspaceContext({
    inputFiles: [{ name: 'sales.csv', data: await fs.readFile(salesPath) }],
    onFileOutput: async (file: FileOutPayload) => {
      if (file.file_name !== 'report.html' || !file.buffer) return
      uploads.push({
        bucket: 'reports',
        key: 'march/report.html',
        body: file.buffer,
      })
    },
  }))

  if (uploads.length !== 1 || uploads[0]!.key !== 'march/report.html') {
    throw new Error(`expected one S3 upload, got ${JSON.stringify(uploads)}`)
  }
  if (Buffer.from(uploads[0]!.body).toString('utf8') !== html) {
    throw new Error('upload body does not match report.html')
  }
}

async function testFilesCallback(tmpDir: string) {
  const outDir = path.join(tmpDir, 'files-out')
  await fs.mkdir(outDir, { recursive: true })
  const onFileOutput = (file: FileOutPayload) =>
    fs.copyFile(file.path, path.join(outDir, file.file_name))

  const agent = reporterAgent(
    scriptedModel([
      [callTool('sandbox_write_file', { path: '/workspace/brief.docx', content: 'brief' })],
      [assistant('done')],
    ]),
  )

  await run(agent, 'write brief', WorkspaceContext({ onFileOutput }))
  const copied = await fs.readFile(path.join(outDir, 'brief.docx'), 'utf8')
  if (copied !== 'brief') throw new Error('onFileOutput copy failed')
}

async function testStreaming(tmpDir: string) {
  const outDir = path.join(tmpDir, 'stream-out')
  await fs.mkdir(outDir, { recursive: true })
  const onFileOutput = (file: FileOutPayload) =>
    fs.copyFile(file.path, path.join(outDir, file.file_name))

  const agent = reporterAgent(
    scriptedModel([
      [callTool('sandbox_write_file', { path: '/workspace/out.md', content: '# report' })],
      [assistant('done')],
    ]),
  )

  const result = await run(agent, 'Draft a brief', {
    stream: true,
    ...WorkspaceContext({ onFileOutput }),
  })
  for await (const _event of result) {
    /* README iterates events */
  }
  await result.completed

  const text = await fs.readFile(path.join(outDir, 'out.md'), 'utf8')
  if (text !== '# report') throw new Error('streaming run did not emit file output')
}

async function testSessions(tmpDir: string) {
  const sessionName = `readme-e2e-${Date.now()}`
  const workspaceRoot = path.join(tmpDir, 'workspaces')
  await fs.mkdir(workspaceRoot, { recursive: true })
  const inputFiles = [{ name: 'sales.csv', data: Buffer.from('sku,qty\nA,1\n') }]

  const writeTurn1 = scriptedModel([
    [callTool('sandbox_run', { script: "open('/workspace/turn1.txt','w').write('draft')" })],
    [assistant('drafted')],
  ])
  const writeTurn2 = scriptedModel([
    [
      callTool('sandbox_run', {
        script: "open('/workspace/turn2.txt','w').write(open('/workspace/turn1.txt').read())",
      }),
    ],
    [assistant('copied')],
  ])

  try {
    await run(sessionAgent(writeTurn1), 'Draft it', WorkspaceContext({
      sandboxName: sessionName,
      inputFiles,
      workspaceRoot,
    }))
    await run(sessionAgent(writeTurn2), 'Now shorten it', WorkspaceContext({
      sandboxName: sessionName,
      skipInputSeed: true,
      workspaceRoot,
    }))

    const sessions = await listSessions({ workspaceRoot })
    if (!sessions.some((s) => s.name === sessionName)) {
      throw new Error(`session ${sessionName} not listed`)
    }

    await endSession(sessionName, { workspaceRoot })
    const after = await listSessions({ workspaceRoot })
    if (after.some((s) => s.name === sessionName)) {
      throw new Error('session still listed after endSession')
    }
  } finally {
    await endSession(sessionName, { workspaceRoot, keepFiles: true }).catch(() => {})
  }
}

async function testNetworkModes() {
  sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', network: 'none' })
  sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', network: 'public' })
  sandboxConfig({
    image: 'python:3.12-slim',
    interpreter: 'python3',
    network: { allow: ['api.example.com', '*.github.com', '10.0.0.0/8'] },
  })

  const agent = reporterAgent(
    scriptedModel([
      [callTool('sandbox_exec', { command: 'echo ok' })],
      [assistant('done')],
    ]),
  )
  await run(agent, 'exec', WorkspaceContext({}))
}

async function testSandboxHandleExternalLifecycle(tmpDir: string) {
  const name = `mst-handle-ext-${Date.now()}`
  const hostDir = path.join(tmpDir, 'handle-ext-ws')
  await fs.mkdir(hostDir, { recursive: true })
  const sb = await createBoundSandbox(name, hostDir)

  try {
    const agent = handleAgent(
      scriptedModel([
        [callTool('sandbox_exec', { command: 'echo handle-smoke-ok' })],
        [assistant('done')],
      ]),
    )

    await run(agent, 'exec smoke', { sandboxHandle: sb })

    const status = (await Sandbox.get(name)).status
    if (status !== 'running') {
      throw new Error(`expected VM still running after external lifecycle, got ${status}`)
    }
  } finally {
    await sb.stop().catch(() => {})
    await Sandbox.remove(name).catch(() => {})
  }
}

async function testSandboxHandleConnectOrStart(tmpDir: string) {
  const name = `mst-handle-start-${Date.now()}`
  const hostDir = path.join(tmpDir, 'handle-start-ws')
  await fs.mkdir(hostDir, { recursive: true })
  const sb = await createBoundSandbox(name, hostDir)
  await sb.stop()

  try {
    const handle = await Sandbox.get(name)
    if (handle.status !== 'stopped') {
      throw new Error(`expected stopped before run, got ${handle.status}`)
    }

    const agent = handleAgent(
      scriptedModel([
        [callTool('sandbox_exec', { command: 'echo revived-from-stopped' })],
        [assistant('done')],
      ]),
    )

    await run(agent, 'revive', { sandboxHandle: handle })

    const status = (await Sandbox.get(name)).status
    if (status !== 'running') {
      throw new Error(`connectOrStart at run() should leave VM running, got ${status}`)
    }
  } finally {
    await sb.stop().catch(() => {})
    await Sandbox.remove(name).catch(() => {})
  }
}

async function testSandboxHandleFileOutputGuestDiff(tmpDir: string) {
  const name = `mst-handle-files-${Date.now()}`
  const hostDir = path.join(tmpDir, 'handle-files-ws')
  await fs.mkdir(hostDir, { recursive: true })
  const sb = await createBoundSandbox(name, hostDir)
  const html = '<p>handle report</p>'
  const events: { name: string; change: string }[] = []

  try {
    const agent = handleAgent(
      scriptedModel([
        [callTool('sandbox_write_file', { path: '/workspace/report.html', content: html })],
        [assistant('done')],
      ]),
    )

    await run(agent, 'write report', {
      sandboxHandle: sb,
      ...WorkspaceContext({
        inputFiles: [{ name: 'seed.txt', data: Buffer.from('seed') }],
        onFileOutput: (file) => {
          events.push({ name: file.file_name, change: file.change })
        },
      }),
    })

    const report = events.find((e) => e.name === 'report.html')
    if (report?.change !== 'created') {
      throw new Error(`report.html expected change=created, got ${JSON.stringify(events)}`)
    }
  } finally {
    await Sandbox.remove(name).catch(() => {})
  }
}

async function testSandboxHandleRejectsSandboxConfig(tmpDir: string) {
  const name = `mst-handle-conflict-${Date.now()}`
  const hostDir = path.join(tmpDir, 'handle-conflict-ws')
  await fs.mkdir(hostDir, { recursive: true })
  const sb = await createBoundSandbox(name, hostDir)

  try {
    const agent = new Agent({
      name: 'bad',
      instructions: 'test',
      tools: [
        sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3' }),
        sandboxExec(),
      ],
      model: scriptedModel([
        [callTool('sandbox_run', { script: 'print(1)' })],
        [assistant('done')],
      ]),
    })

    await run(agent, 'conflict', { sandboxHandle: sb })
    throw new Error('expected sandboxConfig + sandboxHandle to fail')
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('sandboxHandle was passed')) {
      throw err
    }
  } finally {
    await sb.stop().catch(() => {})
    await Sandbox.remove(name).catch(() => {})
  }
}

async function testSandboxOptionsCompile() {
  sandboxConfig({
    image: 'python:3.12-slim',
    interpreter: 'python3',
    network: 'public',
    packages: ['python-docx'],
    timeoutSecs: 120,
    maxOutputBytes: 32768,
    memory: 512,
    cpus: 1,
    persist: true,
    secrets: [{ env: 'API_KEY', value: 'test', host: 'api.example.com' }],
    env: { TZ: 'UTC' },
    configure: (builder) => builder,
  })
}

async function main() {
  process.env.OPENAI_AGENTS_DISABLE_TRACING = '1'

  if (!microsandboxSupported) {
    console.log(
      `skip: readme e2e (microsandbox unsupported on ${process.platform}-${process.arch})`,
    )
    process.exit(0)
  }
  if (!isRuntimeInstalled()) {
    console.log('skip: readme e2e (microsandbox runtime is not installed)')
    process.exit(0)
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-readme-e2e-'))

  try {
    await cleanupSandboxes()

    for (const [name, fn] of [
      ['getting started (HTML report + file callback)', () => testGettingStarted(tmpDir)],
      ['files onFileOutput', () => testFilesCallback(tmpDir)],
      ['streaming + completed', () => testStreaming(tmpDir)],
      ['sessions persist + endSession', () => testSessions(tmpDir)],
      ['network sandboxConfig shapes', () => testNetworkModes()],
      ['sandboxHandle external lifecycle (VM stays up)', () => testSandboxHandleExternalLifecycle(tmpDir)],
      ['sandboxHandle connectOrStart from stopped', () => testSandboxHandleConnectOrStart(tmpDir)],
      ['sandboxHandle guest diff + onFileOutput', () => testSandboxHandleFileOutputGuestDiff(tmpDir)],
      ['sandboxHandle rejects sandboxConfig()', () => testSandboxHandleRejectsSandboxConfig(tmpDir)],
      ['sandboxConfig options (README snippet)', () => testSandboxOptionsCompile()],
    ] as const) {
      try {
        await fn()
        ok(name)
      } catch (err) {
        fail(name, err)
      }
    }
  } finally {
    await cleanupSandboxes()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
