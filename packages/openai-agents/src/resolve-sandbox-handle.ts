import { Sandbox, type SandboxHandle } from 'microsandbox'
import type { Sandbox as SandboxInstance } from 'microsandbox'
import { SandboxSetupError } from './core/index.js'

export type MstSandboxHandleInput =
  | SandboxInstance
  | SandboxHandle
  | Promise<SandboxInstance | SandboxHandle>

function isConnectedSandbox(v: unknown): v is SandboxInstance {
  return typeof v === 'object' && v !== null && typeof (v as SandboxInstance).fs === 'function'
}

function isDetachedHandle(v: unknown): v is SandboxHandle {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SandboxHandle).connectOrStart === 'function' &&
    !isConnectedSandbox(v)
  )
}

/** Connect, start, or resume the sandbox before the model runs. */
export async function resolveSandboxHandle(input: MstSandboxHandleInput): Promise<SandboxInstance> {
  try {
    const value = await Promise.resolve(input)

    if (isDetachedHandle(value)) {
      if (value.status === 'paused') await value.resume()
      return await value.connectOrStart()
    }

    if (isConnectedSandbox(value)) {
      const handle = await Sandbox.get(value.name)
      if (handle.status === 'paused') await value.resume()
      return value
    }

    throw new SandboxSetupError(
      '[mst] sandboxHandle must be a connected microsandbox Sandbox or a SandboxHandle',
    )
  } catch (err) {
    if (err instanceof SandboxSetupError) throw err
    throw new SandboxSetupError(err instanceof Error ? err.message : String(err), { cause: err })
  }
}
