# openai-agents-msb

**Give [OpenAI Agents](https://github.com/openai/openai-agents-python) an isolated [microsandbox](https://github.com/superradcompany/microsandbox) VM to run code and edit files in.**

- **Drop-in `run()`**: Same arguments as `Runner.run()`. Swap the call, keep your agent.
- **Files in, files out**: Seed `/workspace`, get every new or changed file back after the run.
- **Lazy VMs**: The sandbox boots on the first tool call. Chat-only turns cost nothing.
- **Locked-down network**: No network by default; allow the public internet or specific hosts.
- **Secrets that stay out**: Code in the VM sees a placeholder, never the real key.
- **Persistent sessions**: Keep one VM per conversation across turns.

## Getting Started

```sh
pip install openai-agents-msb
```

> **Requirements**: Python 3.10+ on macOS (Apple Silicon), Linux (KVM) or Windows (WHP).
>
> If you also use the TypeScript SDK, keep **`microsandbox` on the same version** in both environments
> (see `pip show microsandbox` and `npm ls microsandbox`). Mixed versions can break sandbox listing with
> `database schema is newer than this msb binary`.

```python
import asyncio
from pathlib import Path

from agents import Agent
from openai_agents_msb import (
    InputFile,
    WorkspaceContext,
    run,
    sandbox_config,
    sandbox_exec,
    sandbox_read_file,
    sandbox_write_file,
)

agent = Agent(
    name="reporter",
    instructions="Write report.html. A table of the rows, then the totals.",
    tools=[
        sandbox_config(image="python:3.12-slim", interpreter="python3"),
        sandbox_exec(),
        sandbox_read_file(),
        sandbox_write_file(),
    ],
)


async def on_report(file) -> None:
    if file.file_name != "report.html" or not file.data:
        return
    # your client, e.g. boto3
    s3.put_object(
        Bucket="reports",
        Key="march/report.html",
        Body=file.data,
        ContentType="text/html",
    )


async def main() -> None:
    await run(
        agent,
        "March sales report",
        WorkspaceContext(
            input_files=[InputFile("sales.csv", Path("sales.csv").read_bytes())],
            on_file_output=on_report,
        ),
    )


asyncio.run(main())
```

`run()` takes the workspace as an optional third positional argument; everything else is passed
through to `Runner.run()` unchanged. `run_sync()` mirrors `Runner.run_sync()`.

## Tools

| Tool | Does |
|---|---|
| `sandbox_config(**options)` | Runs a script; configures the sandbox |
| `sandbox_exec(timeout_secs=600, max_output_bytes=32768)` | Runs a shell command |
| `sandbox_read_file()` | Reads a text file |
| `sandbox_write_file()` | Writes a text file |
| `sandbox_list_files()` | Lists a directory |

The model sees these as `sandbox_run`, `sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`
and `sandbox_list_files`.

<details>
<summary><em>All <code>sandbox_config</code> options →</em></summary>

```python
sandbox_config(
    image="python:3.12-slim",
    interpreter="python3",
    network="public",                  # see Network
    packages=["python-docx"],          # pip install on start
    timeout_secs=120,                  # per script, default 30
    max_output_bytes=32768,            # stdout/stderr sent to the model
    memory=512,                        # MiB
    cpus=1,
    persist=True,                      # see Sessions
    secrets=[SandboxSecret(env="API_KEY", value=key, host="api.example.com")],
    env={"TZ": "UTC"},
    create_kwargs={},                  # merged into microsandbox Sandbox.create()
)
```

Handoffs and `agent.as_tool()` agents share the run's sandbox. Tools with no `sandbox_config()`
anywhere use `python:3.12-slim`.

</details>

## Files

`on_file_output` fires for each new or changed file after the run. `file_name` is relative to
`/workspace`; `path` is valid during the callback; `data` is `None` for files of 2 GiB or more.
Both callbacks may be sync or async.

```python
WorkspaceContext(
    input_files=[InputFile("brief.docx", data), Path("contract.pdf")],
    on_file_output=lambda f: shutil.copy(f.path, f.file_name),
    on_workspace_snapshot=lambda paths: print(paths),
)
```

## Streaming

```python
result = run_streamed(agent, "Draft a brief", WorkspaceContext(on_file_output=save))
async for event in result.stream_events():
    ...
# outputs delivered and the VM stopped once the stream ends
```

Teardown runs when the stream finishes, including when you break out early or the run is
cancelled. If you don't want the events, `await result.wait_completed()` instead.

## Network

```python
sandbox_config(..., network="none")      # default
sandbox_config(..., network="public")    # internet, not LAN or cloud metadata
sandbox_config(..., network=Allow(["api.example.com", "*.github.com", "10.0.0.0/8"]))
```

`secrets` hosts and PyPI (for `packages`) are allowed automatically. A host that echoes request
headers back can leak a secret's real value, so only scope secrets to APIs you trust. Pass a
`microsandbox.Network` to bypass the shorthand entirely.

## Sessions

Set `persist=True` on `sandbox_config()` and pass a `sandbox_name` to keep one VM per conversation.

```python
# sandbox_config(..., persist=True) on the agent
await run(agent, "Draft it", WorkspaceContext(sandbox_name="case-42", input_files=files))
await run(agent, "Now shorten it", WorkspaceContext(sandbox_name="case-42", skip_input_seed=True))

await end_session("case-42")   # delete the VM and its files
await list_sessions()          # [SessionInfo(name, workspace_dir, sandbox, last_used)]
```

A follow-up on a deleted session raises `SessionNotFoundError`. Runs on the same session are
queued. Session workspaces live under `~/.mst/workspaces` unless you set `workspace_root`.

## License

MIT
