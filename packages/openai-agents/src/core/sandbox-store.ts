import { AsyncLocalStorage } from 'node:async_hooks'
import type { Sandbox } from 'microsandbox'
import type { SandboxConfig } from './types.js'

/** Hands out the run's sandbox, creating it on first use. */
export interface SandboxProvider {
  /** `requested` is the calling sandboxConfig()'s options; other tools pass nothing. */
  get(requested?: SandboxConfig): Promise<Sandbox>
}

/**
 * Sandbox setup or configuration failed. Tools rethrow it instead of reporting it
 * to the model, so it fails the run for the developer.
 */
export class SandboxSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SandboxSetupError'
  }
}

export const sandboxStore = new AsyncLocalStorage<SandboxProvider>()

export async function getActiveSandbox(requested?: SandboxConfig): Promise<Sandbox> {
  const provider = sandboxStore.getStore()
  if (!provider) {
    throw new SandboxSetupError(
      '[mst] No active sandbox. Wrap your run() call with openai-agents-msb run()',
    )
  }
  return provider.get(requested)
}
