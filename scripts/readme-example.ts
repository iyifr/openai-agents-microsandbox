// Type-checks the TypeScript examples in README.md. Not shipped; `tsc --noEmit` only.
import fs from 'node:fs'
import { Agent } from '@openai/agents'
import {
  endSession,
  listSessions,
  run,
  sandboxConfig,
  sandboxExec,
  sandboxListFiles,
  sandboxReadFile,
  sandboxWriteFile,
} from '../packages/openai-agents/src/index.js'
import { WorkspaceContext } from '../packages/openai-agents/src/core/index.js'
import type { FileOutPayload } from '../packages/openai-agents/src/core/index.js'

// Stand-ins for the S3 client in the README. Not part of the published example.
declare class PutObjectCommand {
  constructor(input: { Bucket: string; Key: string; Body: Uint8Array; ContentType: string })
}
declare const s3: { send(command: PutObjectCommand): Promise<unknown> }

// --- Getting Started ---
const agent = new Agent({
  name: 'reporter',
  instructions: 'Write report.html. A table of the rows, then the totals.',
  tools: [
    sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3' }),
    sandboxExec(),
    sandboxReadFile(),
    sandboxWriteFile(),
  ],
})

await run(agent, 'March sales report', WorkspaceContext({
  inputFiles: [{ name: 'sales.csv', data: fs.readFileSync('sales.csv') }],
  onFileOutput: async (file) => {
    if (file.file_name !== 'report.html' || !file.buffer) return
    // your client, e.g. @aws-sdk/client-s3
    await s3.send(new PutObjectCommand({
      Bucket: 'reports',
      Key: 'march/report.html',
      Body: file.buffer,
      ContentType: 'text/html',
    }))
  },
}))

// --- Tools table ---
sandboxExec({ timeoutSecs: 600, maxOutputBytes: 32768 })
sandboxListFiles()

// --- All sandbox options ---
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
  configure: (builder) => builder,
})

// --- Files ---
const data = fs.readFileSync('brief.docx')
const pdf = fs.readFileSync('contract.pdf')
const onFileOutput = (file: FileOutPayload) => fs.copyFileSync(file.path, file.file_name)

WorkspaceContext({
  inputFiles: [{ name: 'brief.docx', data }, new File([pdf], 'contract.pdf')],
  onFileOutput,
  onWorkspaceSnapshot: (paths) => console.log(paths),
})

// --- Streaming ---
const streamed = await run(agent, 'Draft a brief', {
  stream: true,
  ...WorkspaceContext({ onFileOutput }),
})
for await (const event of streamed) {
  void event
}
await streamed.completed

// --- Network ---
sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', network: 'none' })
sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', network: 'public' })
sandboxConfig({
  image: 'python:3.12-slim',
  interpreter: 'python3',
  network: { allow: ['api.example.com', '*.github.com', '10.0.0.0/8'] },
})

// --- Sessions ---
const sessionAgent = new Agent({
  name: 'reporter',
  instructions: 'Write report.html. A table of the rows, then the totals.',
  tools: [
    sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3', persist: true }),
    sandboxExec(),
    sandboxReadFile(),
    sandboxWriteFile(),
  ],
})
const inputFiles = [{ name: 'sales.csv', data: fs.readFileSync('sales.csv') }]
await run(sessionAgent, 'Draft it', WorkspaceContext({ sandboxName: 'case-42', inputFiles }))
await run(sessionAgent, 'Now shorten it', WorkspaceContext({ sandboxName: 'case-42', skipInputSeed: true }))

await endSession('case-42')
const sessions = await listSessions()
for (const { name, sandbox, lastUsed, workspaceDir } of sessions) {
  console.log(name, sandbox, lastUsed, workspaceDir)
}
