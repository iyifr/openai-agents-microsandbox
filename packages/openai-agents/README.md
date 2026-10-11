# openai-agents-msb

**Give [OpenAI Agents](https://github.com/openai/openai-agents-js) an isolated [microsandbox](https://github.com/superradcompany/microsandbox) VM to run code and edit files in.**

- **Drop-in `run()`**: Same signatures as `@openai/agents`. Swap the import, keep your agent.
- **You own the VM**: Create a microsandbox yourself, pass `sandboxHandle` on `run()` — tools stay stateless on the agent.
- **Files in, files out**: Copy into `/workspace` at run start; after the run, `onFileOutput` fires for each **created** or **modified** file (guest diff).
- **Locked-down network**: Configure on the sandbox builder when you need internet or allowlists.
- **Legacy auto-provision**: Still supported via `sandboxConfig()` if you do not pass a handle.

## Getting Started

```sh
npm i openai-agents-msb @openai/agents microsandbox zod
```

> **Requirements**: Node.js 22+ on macOS (Apple Silicon), Linux (KVM) or Windows (WHP).
>
> If you also use the Python SDK, keep **`microsandbox` on the same version** in both projects (e.g. `0.7.7`).
> A mismatch often shows up as `database schema is newer than this msb binary`. Run `npm ls microsandbox`
> after upgrades.

```ts
import fs from 'node:fs'
import { Agent } from '@openai/agents'
import { Sandbox } from 'microsandbox'
import {
  run,
  sandboxExec,
  sandboxReadFile,
  sandboxWriteFile,
  sandboxListFiles,
} from 'openai-agents-msb'
import { WorkspaceContext } from 'openai-agents-msb/core'
import type { FileChangeKind } from 'openai-agents-msb/core'

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
      const kind: FileChangeKind = file.change // 'created' | 'modified'
      console.log(`report ${kind}, ${file.size} bytes`)
      // your client, e.g. @aws-sdk/client-s3
      await s3.send(new PutObjectCommand({
        Bucket: 'reports',
        Key: 'march/report.html',
        Body: file.buffer,
        ContentType: 'text/html',
      }))
    },
  }),
})

// Same VM, follow-up turn — user message only; skip re-uploading inputs
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
```

### `sandboxHandle`

Attach the VM on **`run()`**, not on each tool. Accepted types:

```ts
sandboxHandle: sb // connected Sandbox from microsandbox
sandboxHandle: await Sandbox.get('worker') // SandboxHandle — connectOrStart at run()
sandboxHandle: Sandbox.builder('worker').image('python:3.12-slim').connectOrCreate()
```

| Option | Default | Meaning |
|--------|---------|---------|
| `stopOnRunEnd` | `false` when a handle is set | MST calls `stop()` after the run when `true` |
| `WorkspaceContext.sandboxName` | optional | Must match `sb.name` if you set it |

Do not combine `sandboxHandle` with `sandboxConfig()` on the same agent.

## Tools

| Tool | Does |
|---|---|
| `sandboxExec({ timeoutSecs?, maxOutputBytes? })` | Shell command in the VM (default timeout 600s) |
| `sandboxReadFile()` | Read a text file |
| `sandboxWriteFile()` | Write a text file |
| `sandboxListFiles()` | List a directory |
| `sandboxConfig(options)` | **Legacy** — provisions the VM and adds a `sandbox_run` script tool |

Model-facing names stay `sandbox_exec`, `sandbox_read_file`, etc.

## Files

At **end of each `run()`**, MST diffs `/workspace` against the start of that run.

| `onFileOutput` field | Meaning |
|----------------------|---------|
| `change` | `'created'` — new path; `'modified'` — existed and content changed |
| `file_name` | Path relative to `/workspace` |
| `buffer` | File bytes when under 2 GiB |
| `path` | Guest path (with `sandboxHandle`); host path with legacy bind mount |

```ts
WorkspaceContext({
  inputFiles: [{ name: 'sales.csv', data: buf }, new File([pdf], 'brief.pdf')],
  skipInputSeed: true, // follow-up turn: VM already has files
  onFileOutput: (file) => {
    if (file.change === 'created') uploadNew(file)
    if (file.change === 'modified') overwrite(file)
  },
  onWorkspaceSnapshot: (paths) => console.log(paths),
})
```

Deletes are not reported. Callbacks run once per changed file after the agent finishes, not after each tool call.

## Streaming

```ts
const result = await run(agent, 'Add a summary section to report.html', {
  stream: true,
  sandboxHandle: sb,
  stopOnRunEnd: false,
  ...WorkspaceContext({ skipInputSeed: true, onFileOutput }),
})
for await (const event of result) { /* ... */ }
await result.completed // file outputs delivered
```

## Legacy: MST provisions the VM

If you omit `sandboxHandle`, MST creates a VM on the first sandbox tool call (lazy — chat-only turns cost nothing).

```ts
import { run, sandboxConfig, sandboxExec, sandboxReadFile, sandboxWriteFile } from 'openai-agents-msb'

const agent = new Agent({
  name: 'reporter',
  instructions: 'Write report.html from /workspace/sales.csv.',
  tools: [
    sandboxConfig({ image: 'python:3.12-slim', interpreter: 'python3' }),
    sandboxExec(),
    sandboxReadFile(),
    sandboxWriteFile(),
  ],
})

await run(agent, 'March sales report', WorkspaceContext({
  inputFiles: [{ name: 'sales.csv', data: fs.readFileSync('sales.csv') }],
  onFileOutput: (file) => { /* ... */ },
}))
```

<details>
<summary><em>All <code>sandboxConfig</code> options →</em></summary>

```ts
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
```

Handoffs share one VM per run. With no `sandboxConfig()`, tools default to `python:3.12-slim`.

</details>

### Network (legacy `sandboxConfig`)

```ts
sandboxConfig({ network: 'none' })
sandboxConfig({ network: 'public' })
sandboxConfig({ network: { allow: ['api.example.com', '*.github.com', '10.0.0.0/8'] } })
```

With `sandboxHandle`, set network on `Sandbox.builder(...)` instead.

### Sessions (legacy)

```ts
// sandboxConfig({ ..., persist: true }) on the agent
await run(agent, 'Draft the report', WorkspaceContext({ sandboxName: 'case-42', inputFiles }))
await run(agent, 'Tighten the copy', WorkspaceContext({ sandboxName: 'case-42', skipInputSeed: true }))

await endSession('case-42')
await listSessions()
```

## License

MIT
