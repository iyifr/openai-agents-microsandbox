// Type-checks the TypeScript examples in README.md. Not shipped; `tsc --noEmit` only.
import fs from 'node:fs'
import { Agent } from '@openai/agents'
import { Sandbox } from 'microsandbox'
import {
  endSession,
  listSessions,
  run,
  sandboxConfig,
  sandboxExec,
  sandboxListFiles,
  sandboxReadFile,
  sandboxWriteFile,
  type MstSandboxHandleInput,
} from '../packages/openai-agents/src/index.js'
import { WorkspaceContext } from '../packages/openai-agents/src/core/index.js'
import type { FileChangeKind, FileOutPayload } from '../packages/openai-agents/src/core/index.js'

declare class PutObjectCommand {
  constructor(input: { Bucket: string; Key: string; Body: Uint8Array; ContentType: string })
}
declare const s3: { send(command: PutObjectCommand): Promise<unknown> }

const sb = await Sandbox.builder('worker')
  .image('python:3.12-slim')
  .connectOrCreate()

const agent = new Agent({
  name: 'reporter',
  instructions: [
    'You work in /workspace inside an isolated Linux VM.',
    'Input files are already under /workspace — list the directory if you are unsure what is there.',
    'Read data with sandbox_read_file or Python (sandbox_exec). Write HTML and reports under /workspace.',
    'When the user asks to clean up or revise a report, edit the existing file instead of starting over.',
  ].join(' '),
  tools: [sandboxExec(), sandboxReadFile(), sandboxWriteFile(), sandboxListFiles()],
})

await run(agent, 'Generate report.html from sales.csv — table of rows, then totals.', {
  sandboxHandle: sb,
  stopOnRunEnd: false,
  ...WorkspaceContext({
    inputFiles: [{ name: 'sales.csv', data: fs.readFileSync('sales.csv') }],
    onFileOutput: async (file) => {
      if (file.file_name !== 'report.html' || !file.buffer) return
      const kind: FileChangeKind = file.change
      console.log(`report ${kind}, ${file.size} bytes`)
      await s3.send(new PutObjectCommand({
        Bucket: 'reports',
        Key: 'march/report.html',
        Body: file.buffer,
        ContentType: 'text/html',
      }))
    },
  }),
})

await run(agent, 'Clean up the March report: fix column headers and make sure totals match the CSV.', {
  sandboxHandle: sb,
  stopOnRunEnd: false,
  ...WorkspaceContext({
    skipInputSeed: true,
    onFileOutput: async (file) => {
      if (file.change === 'modified' && file.file_name === 'report.html' && file.buffer) {
        await fs.promises.writeFile('report.html', file.buffer)
      }
    },
  }),
})

const handleExamples: MstSandboxHandleInput[] = [
  sb,
  await Sandbox.get('worker'),
  Sandbox.builder('worker').image('python:3.12-slim').connectOrCreate(),
]
void handleExamples

sandboxExec({ timeoutSecs: 600, maxOutputBytes: 32768 })
sandboxListFiles()

const data = fs.readFileSync('brief.docx')
const pdf = fs.readFileSync('contract.pdf')
const onFileOutput = (file: FileOutPayload) => fs.copyFileSync(file.path, file.file_name)

WorkspaceContext({
  inputFiles: [{ name: 'sales.csv', data: data }, new File([pdf], 'brief.pdf')],
  skipInputSeed: true,
  onFileOutput: (file) => {
    if (file.change === 'created') void file
    if (file.change === 'modified') void file
  },
  onWorkspaceSnapshot: (paths) => console.log(paths),
})

const streamed = await run(agent, 'Add a summary section to report.html', {
  stream: true,
  sandboxHandle: sb,
  stopOnRunEnd: false,
  ...WorkspaceContext({ skipInputSeed: true, onFileOutput }),
})
for await (const event of streamed) {
  void event
}
await streamed.completed

const legacyAgent = new Agent({
  name: 'reporter',
  instructions: 'Write report.html from /workspace/sales.csv.',
  tools: [
    sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3' }),
    sandboxExec(),
    sandboxReadFile(),
    sandboxWriteFile(),
  ],
})

await run(legacyAgent, 'March sales report', WorkspaceContext({
  inputFiles: [{ name: 'sales.csv', data: fs.readFileSync('sales.csv') }],
  onFileOutput,
}))

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
  secrets: [{ env: 'API_KEY', value: process.env.API_KEY!, host: 'api.example.com' }],
  env: { TZ: 'UTC' },
})

sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', network: 'none' })
sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', network: 'public' })
sandboxConfig({
  image: 'python:3.12-slim',
  interpreter: 'python3',
  network: { allow: ['api.example.com', '*.github.com', '10.0.0.0/8'] },
})

const sessionAgent = new Agent({
  name: 'reporter',
  instructions: 'Write report.html from /workspace/sales.csv.',
  tools: [
    sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', persist: true }),
    sandboxExec(),
    sandboxReadFile(),
    sandboxWriteFile(),
  ],
})
const inputFiles = [{ name: 'sales.csv', data: fs.readFileSync('sales.csv') }]
await run(sessionAgent, 'Draft the report', WorkspaceContext({ sandboxName: 'case-42', inputFiles }))
await run(sessionAgent, 'Tighten the copy', WorkspaceContext({ sandboxName: 'case-42', skipInputSeed: true }))

await endSession('case-42')
const sessions = await listSessions()
for (const { name, sandbox, lastUsed, workspaceDir } of sessions) {
  console.log(name, sandbox, lastUsed, workspaceDir)
}
