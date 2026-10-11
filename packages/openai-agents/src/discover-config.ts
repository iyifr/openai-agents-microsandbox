import type { Agent } from '@openai/agents'
import { MST_SANDBOX_CONFIG, MST_TOOL } from './core/index.js'
import type { SandboxConfig } from './core/index.js'

/** Used when an agent has sandbox tools but no sandboxConfig() to configure them. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  image: 'python:3.12-slim',
  interpreter: 'python3',
}

export function configKey(c: SandboxConfig): string {
  return JSON.stringify({
    image: c.image,
    interpreter: c.interpreter,
    cpus: c.cpus ?? 1,
    memory: c.memory ?? 256,
    network: c.network ?? false,
    packages: [...(c.packages ?? [])].sort(),
  })
}

export type DiscoveredSandbox = {
  /** Options from sandboxConfig() tools; undefined if none were found. */
  config: SandboxConfig | undefined
  /** Whether any MST tool is reachable. */
  hasTools: boolean
}

/**
 * Collects sandbox tools from the agent and every agent reachable through handoffs.
 * Agents wrapped with asTool() can't be inspected; their tools get the sandbox lazily.
 */
export function discoverSandboxConfig(agent: Agent<any, any>): DiscoveredSandbox {
  const configs: SandboxConfig[] = []
  let hasTools = false
  const seen = new Set<Agent<any, any>>()
  const visit = (a: Agent<any, any>) => {
    if (seen.has(a)) return
    seen.add(a)
    for (const t of a.tools) {
      const marked = t as { [MST_TOOL]?: boolean; [MST_SANDBOX_CONFIG]?: SandboxConfig }
      if (marked[MST_TOOL]) hasTools = true
      if (marked[MST_SANDBOX_CONFIG]) configs.push(marked[MST_SANDBOX_CONFIG])
    }
    for (const h of a.handoffs ?? []) visit('agent' in h ? h.agent : h)
  }
  visit(agent)

  if (configs.length > 1) {
    const first = configKey(configs[0]!)
    if (configs.some((c) => configKey(c) !== first)) {
      throw new Error(
        '[mst] All sandboxConfig() tools reachable from an agent (including handoffs) must use identical SandboxConfig',
      )
    }
  }
  return { config: configs[0], hasTools }
}
