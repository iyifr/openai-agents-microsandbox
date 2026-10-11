"""README examples against a real VM (scripted model, no API key)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from microsandbox import Sandbox, SandboxNotFoundError, is_runtime_installed

from openai_agents_msb import (
    InputFile,
    WorkspaceContext,
    end_session,
    list_sessions,
    run,
    run_streamed,
    sandbox_config,
    sandbox_exec,
    sandbox_read_file,
    sandbox_write_file,
)

from .conftest import agent_calling, calls_tool, says

pytestmark = [
    pytest.mark.vm,
    pytest.mark.timeout(600),
    pytest.mark.skipif(
        not is_runtime_installed(), reason="microsandbox runtime is not installed"
    ),
]

PY = {"image": "python:3.12-slim", "interpreter": "python3"}
HTML = b"<table><tr><td>A</td><td>1</td></tr></table><p>total: 1</p>"


@pytest.fixture(autouse=True)
async def no_leftover_sandboxes() -> Any:
    yield
    page = await Sandbox.list()
    leftovers = [s.name for s in page.sandboxes if s.name.startswith("mst-")]
    for name in leftovers:
        try:
            await Sandbox.remove(name)
        except SandboxNotFoundError:
            pass
    assert leftovers == [], f"leftover sandboxes: {leftovers}"


def reporter_agent(*steps: Any) -> Any:
    return agent_calling(
        [
            sandbox_config(**PY),  # type: ignore[arg-type]
            sandbox_exec(),
            sandbox_read_file(),
            sandbox_write_file(),
        ],
        *steps,
        name="reporter",
    )


async def test_readme_getting_started_html_report_and_upload_callback() -> None:
    uploads: list[tuple[str, bytes]] = []

    async def on_report(file) -> None:
        if file.file_name != "report.html" or not file.data:
            return
        uploads.append(("march/report.html", file.data))

    agent = reporter_agent(
        calls_tool(
            "sandbox_write_file",
            {"path": "/workspace/report.html", "content": HTML.decode()},
        ),
        says("March report is ready."),
    )
    await run(
        agent,
        "March sales report",
        WorkspaceContext(
            input_files=[InputFile("sales.csv", b"sku,qty\nA,1\n")],
            on_file_output=on_report,
        ),
    )
    assert uploads == [("march/report.html", HTML)]


async def test_readme_files_on_file_output(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()

    def save(file) -> None:
        dest = out / file.file_name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(file.data or Path(file.path).read_bytes())

    agent = reporter_agent(
        calls_tool(
            "sandbox_write_file",
            {"path": "/workspace/brief.docx", "content": "brief"},
        ),
        says("done"),
    )
    await run(agent, "write brief", WorkspaceContext(on_file_output=save))
    assert (out / "brief.docx").read_bytes() == b"brief"


async def test_readme_streaming_snippet() -> None:
    saved: list[str] = []

    def save(file) -> None:
        if file.data:
            saved.append(file.data.decode())

    agent = reporter_agent(
        calls_tool(
            "sandbox_write_file",
            {"path": "/workspace/out.md", "content": "# report"},
        ),
        says("done"),
    )
    result = run_streamed(
        agent, "Draft a brief", WorkspaceContext(on_file_output=save)
    )
    async for _ in result.stream_events():
        pass
    assert saved == ["# report"]
    assert result.final_output == "done"


async def test_readme_sessions_snippet(workspace_root: Path) -> None:
    session_name = "readme-e2e-session"
    files = [InputFile("sales.csv", b"sku,qty\nA,1\n")]

    turn1 = agent_calling(
        [sandbox_config(**PY, persist=True)],  # type: ignore[arg-type]
        calls_tool(
            "sandbox_run",
            {"script": "open('/workspace/turn1.txt','w').write('draft')"},
        ),
        says("drafted"),
    )
    turn2 = agent_calling(
        [sandbox_config(**PY, persist=True)],  # type: ignore[arg-type]
        calls_tool(
            "sandbox_run",
            {
                "script": "open('/workspace/turn2.txt','w').write("
                "open('/workspace/turn1.txt').read())"
            },
        ),
        says("copied"),
    )

    try:
        await run(
            turn1,
            "Draft it",
            WorkspaceContext(
                sandbox_name=session_name,
                input_files=files,
                workspace_root=workspace_root,
            ),
        )
        await run(
            turn2,
            "Now shorten it",
            WorkspaceContext(
                sandbox_name=session_name,
                skip_input_seed=True,
                workspace_root=workspace_root,
            ),
        )
        assert any(s.name == session_name for s in await list_sessions(workspace_root=workspace_root))
    finally:
        await end_session(session_name, workspace_root=workspace_root)

    assert await list_sessions(workspace_root=workspace_root) == []


async def test_readme_network_sandbox_config_shapes() -> None:
    sandbox_config(image="python:3.12-slim", interpreter="python3", network="none")
    sandbox_config(image="python:3.12-slim", interpreter="python3", network="public")
