# openai-agents-msb

**Give [OpenAI Agents](https://github.com/openai/openai-agents-js) an isolated [microsandbox](https://github.com/superradcompany/microsandbox) VM to run code and edit files in.**

- **Drop-in `run()`**: Same signatures as `@openai/agents`. Swap the import, keep your agent.
- **Files in, files out**: Seed `/workspace`, get every new or changed file back after the run.
- **Lazy VMs**: The sandbox boots on the first tool call. Chat-only turns cost nothing.
- **Locked-down network**: No network by default; allow the public internet or specific hosts.
- **Secrets that stay out**: Code in the VM sees a placeholder, never the real key.
- **Persistent sessions**: Keep one VM per conversation across turns.

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
import { run, sandboxConfig, sandboxExec, sandboxReadFile, sandboxWriteFile } from 'openai-agents-msb'
import { WorkspaceContext } from 'openai-agents-msb/core'

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
```

## Tools

| Tool | Does |
|---|---|
| `sandboxConfig(options)` | Runs a script; configures the sandbox |
| `sandboxExec({ timeoutSecs?, maxOutputBytes? })` | Runs a shell command (default timeout 600s) |
| `sandboxReadFile()` | Reads a text file |
| `sandboxWriteFile()` | Writes a text file |
| `sandboxListFiles()` | Lists a directory |

<details>
<summary><em>All <code>sandboxConfig</code> options →</em></summary>

```ts
sandboxConfig({
  image: 'python:3.12-slim',
  interpreter: 'python3',
  network: 'public',           // see Network
  packages: ['python-docx'],   // pip install on start
  timeoutSecs: 120,            // per script, default 30
  maxOutputBytes: 32768,       // stdout/stderr sent to the model
  memory: 512,                 // MB
  cpus: 1,
  persist: true,               // see Sessions
  secrets: [{ env: 'API_KEY', value: process.env.API_KEY!, host: 'api.example.com' }],
  env: { TZ: 'UTC' },
})
```

Handoffs and `agent.asTool()` agents share the run's sandbox. Tools with no `sandboxConfig()` anywhere use `python:3.12-slim`.

</details>

## Files

`onFileOutput` fires for each new or changed file after the run (`change`: `'created' | 'modified'`). `file_name` is relative to `/workspace`;
`path` is valid during the callback; `buffer` is omitted for files over 2 GiB.

```ts
WorkspaceContext({
  inputFiles: [{ name: 'brief.docx', data }, new File([pdf], 'contract.pdf')],
  onFileOutput: (file) => fs.copyFileSync(file.path, file.file_name),
  onWorkspaceSnapshot: (paths) => console.log(paths),
})
```

## Streaming

```ts
const result = await run(agent, 'Draft a brief', { stream: true, ...WorkspaceContext({ onFileOutput }) })
for await (const event of result) { /* ... */ }
await result.completed   // outputs delivered, sandbox stopped
```

## Network

```ts
sandboxConfig({ network: 'none' })                                // default
sandboxConfig({ network: 'public' })                              // internet, not LAN or cloud metadata
sandboxConfig({ network: { allow: ['api.example.com', '*.github.com', '10.0.0.0/8'] } })
```

`secrets` hosts and PyPI (for `packages`) are allowed automatically. A host that echoes request headers back can leak a secret's real value, so only scope secrets to APIs you trust.

## Sessions

Set `persist: true` on `sandboxConfig()` and pass a `sandboxName` to keep one VM per conversation.

```ts
// sandboxConfig({ ..., persist: true }) on the agent
await run(agent, 'Draft it', WorkspaceContext({ sandboxName: 'case-42', inputFiles }))
await run(agent, 'Now shorten it', WorkspaceContext({ sandboxName: 'case-42', skipInputSeed: true }))

await endSession('case-42')        // delete the VM and its files
await listSessions()               // [{ name, sandbox, lastUsed, workspaceDir }]
```

A follow-up on a deleted session throws `SessionNotFoundError`. Runs on the same session are queued.

## License

MIT
