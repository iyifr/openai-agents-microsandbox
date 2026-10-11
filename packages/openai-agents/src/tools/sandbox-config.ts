import { z } from 'zod'
import { mstTool } from './mst-tool.js'
import { getActiveSandbox, MST_SANDBOX_CONFIG } from '../core/index.js'
import type { SandboxConfig } from '../core/index.js'
import { DEFAULT_MAX_OUTPUT_BYTES, execToYaml } from './exec.js'

export function sandboxConfig(options: SandboxConfig) {
  const timeoutMs = (options.timeoutSecs ?? 30) * 1000
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  const t = mstTool({
    name: 'sandbox_run',
    description:
      'Execute a script inside an isolated sandbox. Returns exit code, stdout, and stderr as YAML.',
    parameters: z.object({
      script: z.string().describe('The script content to execute'),
    }),
    execute: async ({ script }, _context, details) => {
      const sb = await getActiveSandbox(options)
      const scriptPath = `/tmp/mst_script_${crypto.randomUUID()}`
      try {
        await sb.fs().write(scriptPath, script)
        return await execToYaml(sb, options.interpreter, [scriptPath], {
          timeoutMs,
          maxOutputBytes,
          signal: details?.signal,
        })
      } finally {
        await sb.fs().remove(scriptPath).catch(() => {})
      }
    },
  })

  Object.assign(t, { [MST_SANDBOX_CONFIG]: options })
  return t
}
