import fs from 'node:fs/promises'
import { run as openaiRun } from '@openai/agents'
import type {
  Agent,
  AgentInputItem,
  NonStreamRunOptions,
  RunResult,
  RunState,
  StreamedRunResult,
  StreamRunOptions,
} from '@openai/agents'

import { Sandbox, SandboxNotFoundError, Volume } from 'microsandbox'
import type { Sandbox as SandboxInstance } from 'microsandbox'
import { sandboxStore, SandboxSetupError, WORKSPACE_CTX, normalizeFile } from './core/index.js'
import type { SandboxProvider, SandboxConfig, WorkspaceContextOptions } from './core/index.js'
import { DEFAULT_SANDBOX_CONFIG, configKey, discoverSandboxConfig } from './discover-config.js'
import { applyNetwork, validateNetwork } from './network.js'
import {
  GUEST_WORKSPACE,
  assertInputNames,
  sessionDir,
  clearWorkspaceDir,
  createWorkspaceDir,
  emitFileOutputs,
  seedInputFiles,
  snapshotWorkspace,
} from './host-workspace.js'
import {
  applySeedContentHashes,
  emitGuestFileOutputs,
  snapshotGuestWorkspace,
} from './guest-workspace.js'
import type { GuestWorkspaceSnapshot } from './guest-workspace.js'
import { mkdirpGuest } from './guest-mkdir.js'
import type { WorkspaceSnapshot } from './host-workspace.js'
import { SessionNotFoundError, acquireSession, assertSessionName } from './session.js'
import { resolveSandboxHandle } from './resolve-sandbox-handle.js'
import type { MstSandboxHandleInput } from './resolve-sandbox-handle.js'

type MstRunExtension = {
  /** Connected Sandbox or SandboxHandle; revived at run() start via connectOrStart / resume. */
  sandboxHandle?: MstSandboxHandleInput
  /**
   * When `sandboxHandle` is set: call `stop()` (and ephemeral removal) after the run.
   * Default `false` — you own VM lifetime. Ignored when MST auto-provisions the VM.
   */
  stopOnRunEnd?: boolean
}

type WorkspaceOption = { [WORKSPACE_CTX]?: WorkspaceContextOptions }

/** `@openai/agents` run options plus the workspace set by `WorkspaceContext()`. */
export type MstNonStreamRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = NonStreamRunOptions<TContext, TAgent> & WorkspaceOption & MstRunExtension

export type MstStreamRunOptions<
  TContext = undefined,
  TAgent extends Agent<any, any> = Agent<any, any>,
> = StreamRunOptions<TContext, TAgent> & WorkspaceOption & MstRunExtension

export type { MstSandboxHandleInput } from './resolve-sandbox-handle.js'

type RunInput<TContext, TAgent extends Agent<any, any>> =
  | string
  | AgentInputItem[]
  | RunState<TContext, TAgent>

function attachStreamSandboxLifecycle(
  result: { completed: Promise<void> },
  finish: () => Promise<void>,
) {
  const completed = result.completed.finally(finish)
  // Still rejects for callers awaiting it; just never reported as unhandled.
  completed.catch(() => {})

  // `completed` is a getter on StreamedRunResult; shadow it so awaiting it includes teardown.
  Object.defineProperty(result, 'completed', { value: completed })
}

/** Drop-in for `run()` from `@openai/agents` that gives the agent's sandbox tools a microsandbox VM. */
export function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: RunInput<TContext, TAgent>,
  options?: MstNonStreamRunOptions<TContext, TAgent>,
): Promise<RunResult<TContext, TAgent>>
export function run<TAgent extends Agent<any, any>, TContext = undefined>(
  agent: TAgent,
  input: RunInput<TContext, TAgent>,
  options?: MstStreamRunOptions<TContext, TAgent>,
): Promise<StreamedRunResult<TContext, TAgent>>
export async function run(
  agent: Agent<any, any>,
  input: RunInput<any, Agent<any, any>>,
  options?: MstNonStreamRunOptions<any> | MstStreamRunOptions<any>,
): Promise<RunResult<any, Agent<any, any>> | StreamedRunResult<any, Agent<any, any>>> {
  if (options != null && 'sandbox' in options && options.sandbox !== undefined) {
    throw new Error(
      '[mst] `options.sandbox` is reserved by @openai/agents for its built-in sandbox ' +
        '(shell/apply_patch). Pass your microsandbox VM as sandboxHandle on MST run(), or use ' +
        'sandboxConfig() for legacy auto-provision. Or import { run } from "@openai/agents" ' +
        'if you need the SDK sandbox instead of MST.',
    )
  }

  const {
    [WORKSPACE_CTX]: workspace,
    sandboxHandle: sandboxHandleInput,
    stopOnRunEnd,
    ...openaiOptions
  } = options ?? {}
  const streaming = openaiOptions.stream === true
  const ws = workspace as WorkspaceContextOptions | undefined

  const discovered = discoverSandboxConfig(agent)
  if (discovered.config) validateNetwork(discovered.config)

  let injectedSb: SandboxInstance | undefined
  if (sandboxHandleInput) {
    injectedSb = await resolveSandboxHandle(sandboxHandleInput)
    if (ws?.sandboxName != null && ws.sandboxName !== injectedSb.name) {
      throw new SandboxSetupError(
        `[mst] WorkspaceContext sandboxName ${JSON.stringify(ws.sandboxName)} does not match ` +
          `sandboxHandle name ${JSON.stringify(injectedSb.name)}`,
      )
    }
  }

  const sessionName = ws?.sandboxName ?? injectedSb?.name

  // Session settings come from the reachable sandboxConfig(); asTool() agents can't be inspected.
  const persistentSession =
    !injectedSb &&
    discovered.config?.persist === true &&
    sessionName != null
  const reusingPersistedSandbox = persistentSession && ws?.skipInputSeed === true
  const name = sessionName ?? `mst-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  if (persistentSession) assertSessionName(name)
  if (ws?.sandboxName != null) assertSessionName(ws.sandboxName)

  const manageVmLifecycle = injectedSb ? (stopOnRunEnd ?? false) : true
  // Checked now: the workspace is only seeded once a sandbox tool runs.
  if (ws?.inputFiles?.length && !ws.skipInputSeed) assertInputNames(ws.inputFiles)

  const releaseSession = sessionName ? await acquireSession(sessionName) : () => {}
  let sandbox: Promise<SandboxInstance> | undefined
  let sandboxKey: string | undefined
  let sb: SandboxInstance | undefined
  let hostDir: string | undefined
  let inputSnapshot: WorkspaceSnapshot = new Map()
  let guestSnapshot: GuestWorkspaceSnapshot | undefined
  const useGuestFileFerry = injectedSb != null
  let handedOff = false

  // Stop the VM before reading outputs so nothing in the guest can change /workspace mid-read.
  const finish = async (emit: boolean) => {
    try {
      await sandbox?.catch(() => {})
      if (manageVmLifecycle) await sb?.stop()
    } finally {
      // An ephemeral VM that died mid-run is not removed by stop().
      if (manageVmLifecycle && sb && !persistentSession) {
        await Sandbox.remove(name).catch(() => {})
      }
      try {
        if (emit && useGuestFileFerry && sb && guestSnapshot) {
          await emitGuestFileOutputs(sb, ws, guestSnapshot)
        } else if (emit && hostDir) {
          await emitFileOutputs(hostDir, ws, inputSnapshot)
        }
      } finally {
        if (hostDir && !persistentSession) await fs.rm(hostDir, { recursive: true, force: true })
        // listSessions() reports this as lastUsed.
        if (hostDir && persistentSession && sb) {
          const now = new Date()
          await fs.utimes(hostDir, now, now).catch(() => {})
        }
        releaseSession()
      }
    }
  }

  const startSandbox = async (config: SandboxConfig): Promise<SandboxInstance> => {
    if (reusingPersistedSandbox) {
      sb = await Sandbox.start(name).catch((err) => {
        if (err instanceof SandboxNotFoundError) {
          throw new SessionNotFoundError(name, 'sandbox was removed')
        }
        throw err
      })
      return sb
    }

    hostDir = await createWorkspaceDir(name, persistentSession, ws?.workspaceRoot)
    await clearWorkspaceDir(hostDir)
    if (ws?.inputFiles?.length && !ws.skipInputSeed) {
      inputSnapshot = await seedInputFiles(hostDir, ws.inputFiles)
    }
    sb = await createSandbox(name, config, hostDir, persistentSession)

    if (config.packages?.length) {
      const out = await sb.shell(`pip install --quiet ${config.packages.join(' ')}`)
      if (!out.success) {
        throw new Error(`[mst] pip install failed (exit ${out.code}):\n${out.stderr()}`)
      }
    }
    return sb
  }

  const provider: SandboxProvider = injectedSb
    ? {
        get(requested) {
          if (requested) {
            return Promise.reject(new SandboxSetupError(
              '[mst] sandboxHandle was passed to run(); remove sandboxConfig() from tools or migrate ' +
                'to sandboxExec()/sandboxReadFile() without embedded VM config.',
            ))
          }
          return Promise.resolve(injectedSb!)
        },
      }
    : {
        // Created on the first sandbox tool call, so handoffs, asTool() agents and
        // tools without a sandboxConfig() all share one VM per run.
        get(requested) {
          const config = requested ?? discovered.config ?? DEFAULT_SANDBOX_CONFIG
          if (sandbox) {
            if (requested && configKey(requested) !== sandboxKey) {
              return Promise.reject(new SandboxSetupError(
                '[mst] All sandboxConfig() tools used in one run must use identical SandboxConfig',
              ))
            }
            return sandbox
          }
          sandboxKey = configKey(config)
          sandbox = (async () => {
            try {
              validateNetwork(config)
              return await startSandbox(config)
            } catch (err) {
              if (err instanceof SessionNotFoundError) throw err
              throw new SandboxSetupError(err instanceof Error ? err.message : String(err), { cause: err })
            }
          })()
          return sandbox
        },
      }

  try {
    if (injectedSb) {
      sb = injectedSb
      const seedPayload: { name: string; data: Uint8Array }[] = []
      if (ws?.inputFiles?.length && !ws.skipInputSeed) {
        for (const f of ws.inputFiles) {
          const { name: fileName, data } =
            f instanceof File
              ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) }
              : normalizeFile(f)
          const guestPath = `${GUEST_WORKSPACE}/${fileName}`
          await mkdirpGuest(injectedSb.fs(), guestPath)
          await injectedSb.fs().write(guestPath, data)
          seedPayload.push({ name: fileName, data })
        }
      }
      guestSnapshot = await snapshotGuestWorkspace(injectedSb)
      if (seedPayload.length) applySeedContentHashes(guestSnapshot, seedPayload)
    }

    // Fail before the model runs if a follow-up turn targets a deleted session.
    if (reusingPersistedSandbox) {
      hostDir = await fs.realpath(sessionDir(name, ws.workspaceRoot)).catch(() => {
        throw new SessionNotFoundError(name, 'workspace directory is missing')
      })
      await Sandbox.get(name).catch((err) => {
        if (err instanceof SandboxNotFoundError) {
          throw new SessionNotFoundError(name, 'sandbox was removed')
        }
        throw err
      })
      inputSnapshot = await snapshotWorkspace(hostDir)
    }

    if (discovered.hasTools) {
      const toolExecution = (openaiOptions.toolExecution ?? {}) as {
        maxFunctionToolConcurrency?: number | null
      }
      openaiOptions.toolExecution = {
        ...toolExecution,
        maxFunctionToolConcurrency:
          toolExecution.maxFunctionToolConcurrency ?? 1,
      }
    }

    const result = await sandboxStore.run(provider, () =>
      openaiRun(agent, input, openaiOptions as Parameters<typeof openaiRun>[2]),
    )
    handedOff = true

    if (streaming) {
      attachStreamSandboxLifecycle(result as { completed: Promise<void> }, () => finish(true))
      return result
    }
    await finish(true)
    return result
  } finally {
    // Setup or a non-streamed run failed: clean up without masking the original error.
    if (!handedOff) await finish(false).catch(() => {})
  }
}

async function createSandbox(
  name: string,
  config: SandboxConfig,
  hostWorkspaceDir: string,
  persistent: boolean,
) {
  let builder = Sandbox.builder(name)
    .image(config.image)
    .cpus(config.cpus ?? 1)
    .memory(config.memory ?? 256)
    .ephemeral(!persistent)
    .replace()
    .volume(GUEST_WORKSPACE, (m) => m.bind(hostWorkspaceDir))

  builder = applyNetwork(builder, config)

  for (const secret of config.secrets ?? []) {
    builder = builder.secretEnv(secret.env, secret.value, secret.host)
  }

  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      builder = builder.env(k, v)
    }
  }

  for (const vol of config.volumes ?? []) {
    const createIfMissing = vol.createIfMissing ?? true
    try {
      await Volume.get(vol.name)
    } catch {
      if (createIfMissing) {
        await Volume.builder(vol.name).create()
      } else {
        throw new Error(`[mst] Volume not found: ${vol.name}`)
      }
    }
    builder = builder.volume(vol.mountPath, (m) => {
      let mount = m.named(vol.name)
      if (vol.readonly) mount = mount.readonly()
      return mount
    })
  }

  if (config.configure) builder = config.configure(builder)

  return builder.create()
}
